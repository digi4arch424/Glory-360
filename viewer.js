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

    // ── State ────────────────────────────────────────────────────
    var gyroActive = false;
    var rafId      = null;

    // Raw sensor baseline (set on first reading after enable)
    var baseAlpha = null;
    var baseBeta  = null;

    // EMA smoothed deltas
    var smoothYaw   = 0;
    var smoothPitch = 0;

    // Current viewer target (what we're easing toward)
    var targetYaw   = 0;
    var targetPitch = 0;

    // ── Layer 1+2: sensor input handler ─────────────────────────
    function onOrientation(e) {
      if (!gyroActive) return;

      var alpha = e.alpha != null ? e.alpha : 0;
      var beta  = e.beta  != null ? e.beta  : 0;

      // Capture baseline on first valid reading
      if (baseAlpha === null) {
        baseAlpha   = alpha;
        baseBeta    = beta;
        targetYaw   = viewer.getYaw();
        targetPitch = viewer.getPitch();
        smoothYaw   = 0;
        smoothPitch = 0;
        return;
      }

      // Raw deltas from baseline
      var dAlpha = alpha - baseAlpha;
      var dBeta  = beta  - baseBeta;

      // Normalise yaw delta to -180..180 range
      if (dAlpha >  180) dAlpha -= 360;
      if (dAlpha < -180) dAlpha += 360;

      // LAYER 1 — Exponential moving average (low-pass filter)
      // New smoothed value = alpha * rawDelta + (1-alpha) * previousSmoothed
      smoothYaw   = EMA_ALPHA * dAlpha   + (1 - EMA_ALPHA) * smoothYaw;
      smoothPitch = EMA_ALPHA * dBeta    + (1 - EMA_ALPHA) * smoothPitch;

      // LAYER 2 — Dead zone: ignore sub-threshold noise
      var applyYaw   = Math.abs(smoothYaw)   > DEAD_YAW;
      var applyPitch = Math.abs(smoothPitch) > DEAD_PITCH;

      if (applyYaw) {
        targetYaw = targetYaw - smoothYaw * 0.9;
      }
      if (applyPitch) {
        targetPitch = targetPitch + smoothPitch * 0.6;
      }

      // Clamp pitch to safe range
      targetPitch = Math.max(-85, Math.min(85, targetPitch));

      // Advance baseline incrementally so large fast rotations
      // don't accumulate unbounded deltas
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
