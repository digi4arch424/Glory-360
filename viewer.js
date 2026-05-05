(function () {
  "use strict";

  const G = window.Glory360;

  document.addEventListener("DOMContentLoaded", function () {
    const projectId = G.getQueryParam("project");
    const project   = G.getProject(projectId);

    const titleEl  = document.getElementById("viewer-title");
    const statusEl = document.getElementById("viewer-status");
    const panoEl   = document.getElementById("viewer-pano");
    const navEl    = document.getElementById("scene-nav");
    const editLink = document.getElementById("editor-link");
    const gyroBtn  = document.getElementById("gyro-btn");

    if (editLink) editLink.href = "editor.html?project=" + encodeURIComponent(projectId || "");

    function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
    function hideStatus() {
      if (!statusEl) return;
      statusEl.style.transition = "opacity 0.6s";
      statusEl.style.opacity    = "0";
      setTimeout(function () { statusEl.style.display = "none"; }, 700);
    }

    if (!project) { setStatus("Project not found."); return; }

    titleEl.textContent = project.name;
    document.title      = "Glory360 \u2014 " + project.name;

    if (!project.scenes.length) {
      setStatus("No scenes yet. Open the editor and add some.");
      return;
    }
    if (!window.pannellum) {
      setStatus("Pannellum failed to load. Check internet connection.");
      return;
    }

    // ── Build scenes config ──────────────────────────────────────
    var scenesConf = {};
    project.scenes.forEach(function (scene) {
      var cfg = G.panoConfig(scene, project, false);
      scenesConf[scene.id] = Object.assign({ title: scene.name }, cfg);
    });

    var viewer = pannellum.viewer(panoEl, {
      default: { firstScene: project.scenes[0].id, sceneFadeDuration: 700 },
      autoLoad: true,
      showFullscreenCtrl: false,
      showZoomCtrl: true,
      scenes: scenesConf
    });

    // ── Scene navigation bar ─────────────────────────────────────
    if (project.scenes.length > 1) {
      navEl.style.display = "flex";
      function updateNav(activeId) {
        navEl.querySelectorAll(".snav-btn").forEach(function (b) {
          b.classList.toggle("active", b.dataset.sceneId === activeId);
        });
      }
      project.scenes.forEach(function (scene) {
        var b = document.createElement("button");
        b.className       = "snav-btn";
        b.dataset.sceneId = scene.id;
        b.textContent     = scene.name;
        b.onclick         = function () { viewer.loadScene(scene.id); updateNav(scene.id); };
        navEl.appendChild(b);
      });
      updateNav(project.scenes[0].id);
      viewer.on("scenechange", function (id) { updateNav(id); });
    }

    // ════════════════════════════════════════════════════════════
    //  GYROSCOPE MODULE
    //  Three-layer jitter fix for software-fused sensors
    //  (MTK G25 / accelerometer+magnetometer fusion devices)
    //
    //  Layer 1 — Low-pass EMA filter
    //    Blends each raw sensor reading with the previous smoothed
    //    value using alpha. Lower alpha = smoother but more lag.
    //    alpha = 0.12 chosen for TCL 30 SE portrait use.
    //
    //  Layer 2 — Dead zone
    //    Changes smaller than DEAD_YAW / DEAD_PITCH degrees are
    //    ignored entirely, stopping magnetometer drift when still.
    //
    //  Layer 3 — Velocity damping via rAF loop
    //    The viewer glides toward the target position each frame
    //    rather than jumping. EASE controls the blend per frame.
    //    This removes snapping artefacts during movement.
    // ════════════════════════════════════════════════════════════

    // ── Tuning constants ─────────────────────────────────────────
    var EMA_ALPHA  = 0.12;   // Layer 1: smoothing strength (0.05=very smooth, 0.3=responsive)
    var DEAD_YAW   = 0.18;   // Layer 2: yaw dead zone in degrees
    var DEAD_PITCH = 0.12;   // Layer 2: pitch dead zone in degrees
    var EASE       = 0.18;   // Layer 3: easing per rAF frame (0=no movement, 1=instant)
    var SPIKE_MAX    = 5.0;  // Layer 4: tightened to catch smaller fusion spikes
    var SEAM_ZONE    = 45;   // Layer 5: 45deg either side of 0/360 — covers both CW and CCW approach
    var SEAM_FREEZE  = 2;    // Layer 5: drain EMA after just 2 frozen readings (faster reset)

    // ── Helpers ──────────────────────────────────────────────────
    // Normalise any angle delta to the shortest path: -180..180
    function shortestDelta(a, b) {
      var d = a - b;
      while (d >  180) d -= 360;
      while (d < -180) d += 360;
      return d;
    }

    // Wrap a raw compass value to 0..360
    function wrapAlpha(a) {
      a = a % 360;
      if (a < 0) a += 360;
      return a;
    }

    // Returns true if alpha is within SEAM_ZONE degrees of the 0/360 boundary.
    // Zone is symmetric — same width for both CW (approaching from 315+)
    // and CCW (leaving toward 0-45) rotation directions.
    function nearSeam(a) {
      return a < SEAM_ZONE || a > (360 - SEAM_ZONE);
    }

    // Hard-flush all smoothing state — called on seam exit so filter starts clean
    function flushSmoothing() {
      smoothYaw   = 0;
      smoothPitch = 0;
      // Also reset target to current viewer position so no stored movement fires
      targetYaw   = viewer.getYaw();
      targetPitch = viewer.getPitch();
    }

    // ── State ────────────────────────────────────────────────────
    var gyroActive   = false;
    var rafId        = null;
    var seamFreezeCount = 0;  // counts consecutive readings inside seam zone

    // Raw sensor baseline (set on first reading after enable)
    var baseAlpha = null;
    var baseBeta  = null;

    // EMA smoothed deltas
    var smoothYaw   = 0;
    var smoothPitch = 0;

    // Current viewer target (what we're easing toward)
    var targetYaw   = 0;
    var targetPitch = 0;

    // ── Layers 1-5: sensor input handler ────────────────────────
    function onOrientation(e) {
      if (!gyroActive) return;

      var alpha = e.alpha != null ? wrapAlpha(e.alpha) : 0;
      var beta  = e.beta  != null ? e.beta              : 0;

      // Capture baseline on first valid reading
      if (baseAlpha === null) {
        baseAlpha        = alpha;
        baseBeta         = beta;
        targetYaw        = viewer.getYaw();
        targetPitch      = viewer.getPitch();
        smoothYaw        = 0;
        smoothPitch      = 0;
        seamFreezeCount  = 0;
        return;
      }

      // LAYER 5 — Seam freeze
      // The 0/360 boundary on software-fused gyros (MTK G25) is an unstable
      // zone. When alpha enters this region the magnetometer flips sign,
      // causing sustained oscillation that the EMA filter rings on indefinitely.
      // Fix: freeze ALL output while inside the seam zone. After SEAM_FREEZE
      // consecutive frozen readings also reset the EMA accumulators so that
      // when the user exits the zone the filter starts clean with no ringing.
      if (nearSeam(alpha)) {
        seamFreezeCount++;
        // Advance baseline silently so we don't accumulate a huge delta
        // that fires the moment the user exits the zone
        baseAlpha = alpha;
        baseBeta  = beta;
        // Drain EMA every frame inside seam zone after SEAM_FREEZE readings
        // so smoothing state is always zeroed well before we exit
        if (seamFreezeCount >= SEAM_FREEZE) {
          smoothYaw   *= 0.3;  // fast exponential drain toward 0
          smoothPitch *= 0.3;
        }
        return; // No panorama movement while inside seam zone
      }
      // Exiting seam zone — always flush EMA and reset target
      // This guarantees zero residual ringing regardless of how long we were frozen
      if (seamFreezeCount > 0) {
        flushSmoothing();
      }
      seamFreezeCount = 0;

      // Raw deltas — always use shortestDelta so 359->1 = +2, not -358
      var dAlpha = shortestDelta(alpha, baseAlpha);
      var dBeta  = shortestDelta(beta,  baseBeta);

      // LAYER 4 — Spike clamp
      // Drop any single reading with delta above SPIKE_MAX.
      if (Math.abs(dAlpha) > SPIKE_MAX || Math.abs(dBeta) > SPIKE_MAX) {
        baseAlpha = alpha;
        baseBeta  = beta;
        return;
      }

      // LAYER 1 — Exponential moving average (low-pass filter)
      smoothYaw   = EMA_ALPHA * dAlpha + (1 - EMA_ALPHA) * smoothYaw;
      smoothPitch = EMA_ALPHA * dBeta  + (1 - EMA_ALPHA) * smoothPitch;

      // LAYER 2 — Dead zone: ignore sub-threshold noise
      if (Math.abs(smoothYaw) > DEAD_YAW) {
        targetYaw = targetYaw - smoothYaw * 0.9;
      }
      if (Math.abs(smoothPitch) > DEAD_PITCH) {
        targetPitch = targetPitch + smoothPitch * 0.6;
      }

      // Clamp pitch to safe range
      targetPitch = Math.max(-85, Math.min(85, targetPitch));

      // Advance baseline incrementally
      baseAlpha = alpha;
      baseBeta  = beta;
    }

    // ── Layer 3: rAF easing loop ─────────────────────────────────
    function easingLoop() {
      if (!gyroActive) return;
      rafId = requestAnimationFrame(easingLoop);

      var currentYaw   = viewer.getYaw();
      var currentPitch = viewer.getPitch();

      // Interpolate current → target
      var newYaw   = currentYaw   + (targetYaw   - currentYaw)   * EASE;
      var newPitch = currentPitch + (targetPitch - currentPitch) * EASE;

      // Only call setYaw/setPitch if movement is meaningful
      // (avoids pointless redraws when already at target)
      if (Math.abs(newYaw - currentYaw) > 0.005 ||
          Math.abs(newPitch - currentPitch) > 0.005) {
        viewer.setYaw(newYaw, false);
        viewer.setPitch(newPitch, false);
      }
    }

    // ── Start / Stop ─────────────────────────────────────────────
    function startGyro() {
      // Reset all state cleanly
      baseAlpha   = null;
      baseBeta    = null;
      smoothYaw   = 0;
      smoothPitch = 0;
      targetYaw   = viewer.getYaw();
      targetPitch = viewer.getPitch();
      gyroActive  = true;

      window.addEventListener("deviceorientation", onOrientation, true);

      // Start easing loop
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(easingLoop);

      if (gyroBtn) {
        gyroBtn.classList.add("gyro-on");
        gyroBtn.title = "Gyroscope ON — tap to disable";
      }
      setStatus("Gyroscope enabled — move your phone to look around");
      setTimeout(hideStatus, 2500);
    }

    function stopGyro() {
      gyroActive = false;
      window.removeEventListener("deviceorientation", onOrientation, true);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

      if (gyroBtn) {
        gyroBtn.classList.remove("gyro-on");
        gyroBtn.title = "Enable gyroscope";
      }
    }

    function toggleGyro() {
      if (gyroActive) { stopGyro(); return; }

      // iOS 13+ requires explicit permission
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        DeviceOrientationEvent.requestPermission()
          .then(function (state) {
            if (state === "granted") { startGyro(); }
            else { alert("Gyroscope permission denied.\nEnable it in Settings \u2192 Safari \u2192 Motion & Orientation Access."); }
          })
          .catch(function () { startGyro(); });
      } else {
        // Android WebView — no permission needed
        startGyro();
      }
    }

    // Show gyro button only if sensor is available
    if (gyroBtn && window.DeviceOrientationEvent) {
      gyroBtn.style.display = "flex";
      gyroBtn.onclick = toggleGyro;
    }

    // ── Initial status ───────────────────────────────────────────
    setStatus(
      project.scenes.length > 1
        ? "Use hotspots or the bar below to navigate."
        : "Drag to explore \u2022 Tap \uD83E\uDDED to use gyroscope"
    );
    setTimeout(hideStatus, 3500);
  });
})();
