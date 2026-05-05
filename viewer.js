(function () {
  "use strict";

  var G = window.Glory360;

  document.addEventListener("DOMContentLoaded", function () {
    var projectId = G.getQueryParam("project");
    var project   = G.getProject(projectId);

    var titleEl  = document.getElementById("viewer-title");
    var statusEl = document.getElementById("viewer-status");
    var panoEl   = document.getElementById("viewer-pano");
    var navEl    = document.getElementById("scene-nav");
    var editLink = document.getElementById("editor-link");
    var gyroBtn  = document.getElementById("gyro-btn");

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
    document.title      = "Glory360 - " + project.name;

    if (!project.scenes.length) { setStatus("No scenes yet. Open the editor and add some."); return; }
    if (!window.pannellum)      { setStatus("Pannellum failed to load. Check internet connection."); return; }

    // ── Build scenes config async (images from IndexedDB) ────────
    var cfgPromises = project.scenes.map(function (scene) {
      return G.panoConfig(scene, project, false).then(function (cfg) {
        return { id: scene.id, name: scene.name, cfg: cfg };
      });
    });

    var viewer;

    Promise.all(cfgPromises).then(function (results) {
      var scenesConf = {};
      results.forEach(function (r) {
        scenesConf[r.id] = Object.assign({ title: r.name }, r.cfg);
      });

      viewer = pannellum.viewer(panoEl, {
        default: { firstScene: project.scenes[0].id, sceneFadeDuration: 700 },
        autoLoad: true,
        showFullscreenCtrl: false,
        showZoomCtrl: true,
        scenes: scenesConf
      });

      // Scene navigation bar
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
          b.onclick = function () { viewer.loadScene(scene.id); updateNav(scene.id); };
          navEl.appendChild(b);
        });
        updateNav(project.scenes[0].id);
        viewer.on("scenechange", function (id) { updateNav(id); });
      }

      // Gyroscope button
      if (gyroBtn && window.DeviceOrientationEvent) {
        gyroBtn.style.display = "flex";
        gyroBtn.onclick = toggleGyro;
      }

      setStatus(project.scenes.length > 1
        ? "Use hotspots or the bar below to navigate."
        : "Drag to explore. Tap the compass button for gyroscope.");
      setTimeout(hideStatus, 3500);

    }).catch(function (err) {
      setStatus("Failed to load tour: " + err.message);
    });

    // ════════════════════════════════════════════════════════════
    //  GYROSCOPE MODULE — 5-layer jitter fix for MTK G25
    // ════════════════════════════════════════════════════════════

    var EMA_ALPHA    = 0.12;
    var DEAD_YAW     = 0.18;
    var DEAD_PITCH   = 0.12;
    var EASE         = 0.18;
    var SPIKE_MAX    = 5.0;
    var SEAM_ZONE    = 45;
    var SEAM_FREEZE  = 2;

    function shortestDelta(a, b) {
      var d = a - b;
      while (d >  180) d -= 360;
      while (d < -180) d += 360;
      return d;
    }
    function wrapAlpha(a) {
      a = a % 360;
      if (a < 0) a += 360;
      return a;
    }
    function nearSeam(a) {
      return a < SEAM_ZONE || a > (360 - SEAM_ZONE);
    }
    function flushSmoothing() {
      smoothYaw   = 0;
      smoothPitch = 0;
      if (viewer) {
        targetYaw   = viewer.getYaw();
        targetPitch = viewer.getPitch();
      }
    }

    var gyroActive      = false;
    var rafId           = null;
    var seamFreezeCount = 0;
    var baseAlpha       = null;
    var baseBeta        = null;
    var smoothYaw       = 0;
    var smoothPitch     = 0;
    var targetYaw       = 0;
    var targetPitch     = 0;

    function onOrientation(e) {
      if (!gyroActive || !viewer) return;
      var alpha = e.alpha != null ? wrapAlpha(e.alpha) : 0;
      var beta  = e.beta  != null ? e.beta              : 0;

      if (baseAlpha === null) {
        baseAlpha = alpha; baseBeta = beta;
        targetYaw = viewer.getYaw(); targetPitch = viewer.getPitch();
        smoothYaw = 0; smoothPitch = 0; seamFreezeCount = 0;
        return;
      }

      // Layer 5 — Seam freeze
      if (nearSeam(alpha)) {
        seamFreezeCount++;
        baseAlpha = alpha; baseBeta = beta;
        if (seamFreezeCount >= SEAM_FREEZE) {
          smoothYaw   *= 0.3;
          smoothPitch *= 0.3;
        }
        return;
      }
      if (seamFreezeCount > 0) { flushSmoothing(); }
      seamFreezeCount = 0;

      var dAlpha = shortestDelta(alpha, baseAlpha);
      var dBeta  = shortestDelta(beta,  baseBeta);

      // Layer 4 — Spike clamp
      if (Math.abs(dAlpha) > SPIKE_MAX || Math.abs(dBeta) > SPIKE_MAX) {
        baseAlpha = alpha; baseBeta = beta; return;
      }

      // Layer 1 — EMA filter
      smoothYaw   = EMA_ALPHA * dAlpha + (1 - EMA_ALPHA) * smoothYaw;
      smoothPitch = EMA_ALPHA * dBeta  + (1 - EMA_ALPHA) * smoothPitch;

      // Layer 2 — Dead zone
      if (Math.abs(smoothYaw)   > DEAD_YAW)   targetYaw   = targetYaw   - smoothYaw   * 0.9;
      if (Math.abs(smoothPitch) > DEAD_PITCH)  targetPitch = targetPitch + smoothPitch * 0.6;
      targetPitch = Math.max(-85, Math.min(85, targetPitch));

      baseAlpha = alpha; baseBeta = beta;
    }

    // Layer 3 — rAF easing loop
    function easingLoop() {
      if (!gyroActive || !viewer) return;
      rafId = requestAnimationFrame(easingLoop);
      var cy = viewer.getYaw();
      var cp = viewer.getPitch();
      var ny = cy + (targetYaw   - cy) * EASE;
      var np = cp + (targetPitch - cp) * EASE;
      if (Math.abs(ny - cy) > 0.005 || Math.abs(np - cp) > 0.005) {
        viewer.setYaw(ny, false);
        viewer.setPitch(np, false);
      }
    }

    function startGyro() {
      baseAlpha = null; baseBeta = null;
      smoothYaw = 0; smoothPitch = 0;
      if (viewer) { targetYaw = viewer.getYaw(); targetPitch = viewer.getPitch(); }
      gyroActive = true;
      window.addEventListener("deviceorientation", onOrientation, true);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(easingLoop);
      if (gyroBtn) { gyroBtn.classList.add("gyro-on"); gyroBtn.title = "Gyroscope ON - tap to disable"; }
      setStatus("Gyroscope enabled - move your phone to look around");
      setTimeout(hideStatus, 2500);
    }

    function stopGyro() {
      gyroActive = false;
      window.removeEventListener("deviceorientation", onOrientation, true);
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (gyroBtn) { gyroBtn.classList.remove("gyro-on"); gyroBtn.title = "Enable gyroscope"; }
    }

    function toggleGyro() {
      if (gyroActive) { stopGyro(); return; }
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        DeviceOrientationEvent.requestPermission()
          .then(function (state) {
            if (state === "granted") { startGyro(); }
            else { alert("Gyroscope permission denied. Enable in Settings > Safari > Motion & Orientation Access."); }
          })
          .catch(function () { startGyro(); });
      } else {
        startGyro();
      }
    }

  });
})();
