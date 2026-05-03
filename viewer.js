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
      statusEl.style.opacity = "0";
      setTimeout(function () { statusEl.style.display = "none"; }, 700);
    }

    if (!project) { setStatus("Project not found."); return; }

    titleEl.textContent = project.name;
    document.title      = "Glory360 — " + project.name;

    if (!project.scenes.length) {
      setStatus("No scenes yet. Open the editor and add some.");
      return;
    }

    if (!window.pannellum) {
      setStatus("Pannellum failed to load. Check internet connection.");
      return;
    }

    // ── Build scenes config ──────────────────────────────────────
    const scenesConf = {};
    project.scenes.forEach(function (scene) {
      const cfg = G.panoConfig(scene, project, false);
      scenesConf[scene.id] = Object.assign({ title: scene.name }, cfg);
    });

    const viewer = pannellum.viewer(panoEl, {
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
        const b = document.createElement("button");
        b.className = "snav-btn";
        b.dataset.sceneId = scene.id;
        b.textContent = scene.name;
        b.onclick = function () { viewer.loadScene(scene.id); updateNav(scene.id); };
        navEl.appendChild(b);
      });
      updateNav(project.scenes[0].id);
      viewer.on("scenechange", function (id) { updateNav(id); });
    }

    // ── Gyroscope / Device Orientation ───────────────────────────
    var gyroActive    = false;
    var gyroAlpha0    = null;  // initial compass heading (Z axis)
    var gyroBeta0     = null;  // initial tilt forward/back (X axis)
    var gyroGamma0    = null;  // initial tilt left/right (Y axis)
    var gyroRAF       = null;
    var pendingPitch  = null;
    var pendingYaw    = null;
    var lastOrientation = null;

    function onDeviceOrientation(e) {
      if (!gyroActive) return;
      // alpha = compass 0-360, beta = -180 to 180 (tilt fwd/back), gamma = -90 to 90 (tilt L/R)
      var alpha = e.alpha || 0;
      var beta  = e.beta  || 0;
      var gamma = e.gamma || 0;

      // On first reading, store as baseline
      if (gyroAlpha0 === null) {
        gyroAlpha0 = alpha;
        gyroBeta0  = beta;
        gyroGamma0 = gamma;
        return;
      }

      // Delta from baseline
      var dAlpha = alpha - gyroAlpha0;
      var dBeta  = beta  - gyroBeta0;

      // Normalise alpha delta to -180..180
      if (dAlpha >  180) dAlpha -= 360;
      if (dAlpha < -180) dAlpha += 360;

      // Map to panorama coordinates
      // Yaw: phone rotating left/right → horizontal pan
      // Pitch: phone tilting up/down → vertical pan
      pendingYaw   = viewer.getYaw()   - dAlpha * 0.8;
      pendingPitch = viewer.getPitch() + dBeta  * 0.5;

      // Update baseline incrementally (smooth tracking)
      gyroAlpha0 = alpha;
      gyroBeta0  = beta;

      // Apply via rAF to avoid janky mid-frame updates
      if (!gyroRAF) {
        gyroRAF = requestAnimationFrame(applyGyro);
      }
    }

    function applyGyro() {
      gyroRAF = null;
      if (!gyroActive || pendingYaw === null) return;
      viewer.setYaw(pendingYaw, false);
      viewer.setPitch(pendingPitch, false);
      pendingYaw = null; pendingPitch = null;
    }

    function startGyro() {
      gyroAlpha0 = null; gyroBeta0 = null; gyroGamma0 = null;
      gyroActive = true;
      window.addEventListener("deviceorientation", onDeviceOrientation, true);
      if (gyroBtn) {
        gyroBtn.classList.add("gyro-on");
        gyroBtn.title = "Gyroscope ON — tap to disable";
      }
    }

    function stopGyro() {
      gyroActive = false;
      window.removeEventListener("deviceorientation", onDeviceOrientation, true);
      if (gyroRAF) { cancelAnimationFrame(gyroRAF); gyroRAF = null; }
      if (gyroBtn) {
        gyroBtn.classList.remove("gyro-on");
        gyroBtn.title = "Enable gyroscope";
      }
    }

    function toggleGyro() {
      if (gyroActive) { stopGyro(); return; }
      // iOS 13+ requires permission request
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        DeviceOrientationEvent.requestPermission().then(function (state) {
          if (state === "granted") { startGyro(); }
          else { alert("Gyroscope permission denied. Enable it in Settings → Safari → Motion & Orientation Access."); }
        }).catch(function () { startGyro(); });
      } else {
        // Android / older iOS — no permission needed
        startGyro();
      }
    }

    if (gyroBtn) {
      // Only show button if device has orientation sensor
      if (window.DeviceOrientationEvent) {
        gyroBtn.style.display = "flex";
        gyroBtn.onclick = toggleGyro;
      }
    }

    // Status message
    setStatus(
      project.scenes.length > 1
        ? "Use hotspots or the bar below to navigate."
        : "Drag to explore \u2022 Use \u{1F9ED} for gyroscope"
    );
    setTimeout(hideStatus, 3500);
  });
})();
