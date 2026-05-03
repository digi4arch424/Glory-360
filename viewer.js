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

    if (editLink) editLink.href = "editor.html?project=" + encodeURIComponent(projectId || "");

    function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

    if (!project) { setStatus("Project not found."); return; }

    titleEl.textContent = project.name;
    document.title      = "Glory360 — " + project.name;

    if (!project.scenes.length) {
      setStatus("This project has no scenes yet. Open the editor and add some.");
      return;
    }

    if (!window.pannellum) {
      setStatus("Pannellum viewer failed to load. Check your internet connection.");
      return;
    }

    // Build scenes config for multi-scene tour
    const scenesConf = {};
    project.scenes.forEach(function (scene) {
      const cfg = G.panoConfig(scene, project, false);
      scenesConf[scene.id] = Object.assign({ title: scene.name }, cfg);
    });

    const viewer = pannellum.viewer(panoEl, {
      default: {
        firstScene: project.scenes[0].id,
        sceneFadeDuration: 700
      },
      autoLoad: true,
      showFullscreenCtrl: true,
      showZoomCtrl: true,
      scenes: scenesConf
    });

    // Scene navigation bar (shown when there are 2+ scenes)
    if (project.scenes.length > 1) {
      navEl.style.display = "flex";

      function updateNav(activeId) {
        navEl.querySelectorAll(".snav-btn").forEach(function (btn) {
          btn.classList.toggle("active", btn.dataset.sceneId === activeId);
        });
      }

      project.scenes.forEach(function (scene) {
        const btn = document.createElement("button");
        btn.className      = "snav-btn";
        btn.dataset.sceneId = scene.id;
        btn.textContent    = scene.name;
        btn.onclick        = function () { viewer.loadScene(scene.id); updateNav(scene.id); };
        navEl.appendChild(btn);
      });

      updateNav(project.scenes[0].id);
      viewer.on("scenechange", function (sceneId) { updateNav(sceneId); });
    }

    // Auto-dismiss status overlay
    setStatus(
      project.scenes.length > 1
        ? "Use hotspots or the bar below to navigate scenes."
        : "Drag to explore. Pinch or scroll to zoom."
    );
    setTimeout(function () {
      if (!statusEl) return;
      statusEl.style.transition = "opacity 0.6s";
      statusEl.style.opacity    = "0";
      setTimeout(function () { statusEl.style.display = "none"; }, 700);
    }, 3000);
  });
})();
