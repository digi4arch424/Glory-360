(function () {
  "use strict";

  const SK = "glory360.v3";
  const IK = "glory360.img.";

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  }
  function saveImg(id, dataUrl) {
    try { localStorage.setItem(IK + id, dataUrl); }
    catch (e) { alert("Storage full — try a smaller image."); }
  }
  function getImg(id) { return localStorage.getItem(IK + id) || null; }
  function delImg(id) { localStorage.removeItem(IK + id); }
  function resolveUrl(scene) { return getImg(scene.id) || scene.imageUrl || ""; }
  function getProjects() {
    try { const r = localStorage.getItem(SK); const p = r ? JSON.parse(r) : []; return Array.isArray(p) ? p : []; }
    catch (e) { return []; }
  }
  function saveProjects(p) { localStorage.setItem(SK, JSON.stringify(p)); }
  function getProject(id) { return getProjects().find(p => p.id === id) || null; }
  function saveProject(proj) {
    const ps = getProjects();
    const i = ps.findIndex(p => p.id === proj.id);
    if (i === -1) ps.unshift(proj); else ps[i] = proj;
    saveProjects(ps); return proj;
  }
  function createProject(name) {
    const p = { id: uid("proj"), name: name.trim() || "Untitled", scenes: [] };
    const ps = getProjects(); ps.unshift(p); saveProjects(ps); return p;
  }
  function deleteProject(id) { saveProjects(getProjects().filter(p => p.id !== id)); }
  function getQueryParam(name) { return new URLSearchParams(window.location.search).get(name); }

  function hs2cfg(proj, hs, edMode) {
    const tgt = proj.scenes.find(s => s.id === hs.targetSceneId);
    const lbl = hs.label || (tgt ? "Go to " + tgt.name : "Hotspot");
    const c = { pitch: hs.pitch, yaw: hs.yaw, text: lbl };
    if (edMode) { c.type = "info"; } else { c.type = "scene"; c.sceneId = hs.targetSceneId; }
    return c;
  }

  function panoConfig(scene, project, edMode) {
    const cfg = {
      type: "equirectangular", panorama: resolveUrl(scene),
      autoLoad: true, showFullscreenCtrl: true, showZoomCtrl: true,
      hotSpots: scene.hotspots
        .filter(h => project.scenes.find(s => s.id === h.targetSceneId))
        .map(h => hs2cfg(project, h, edMode))
    };
    if (scene.sceneType === "panorama") {
      // Wide panorama (regular photo, not equirectangular).
      // haov=360 wraps it horizontally around the full sphere.
      // vaov is derived from the image aspect ratio: vaov = haov / aspectRatio.
      // This fills the sphere exactly with no black bars top/bottom.
      // We store the aspect ratio on the scene when the image is loaded (see editor.js).
      // Fallback to 4:1 (a common wide panorama ratio) if not yet measured.
      var aspect = scene.aspectRatio || 4;
      var haov = 360;
      var vaov = haov / aspect;
      // Cap vaov so it never exceeds 180 (full sphere vertical)
      if (vaov > 150) vaov = 150;
      cfg.haov = haov;
      cfg.vaov = vaov;
      cfg.pitch = 0;
      cfg.yaw = 0;
      // Initial hfov: show roughly 90deg of the panorama width
      cfg.hfov = 90;
      cfg.minHfov = 40;
      cfg.maxHfov = 120;
      // Clamp vertical pan to the actual image area (half of vaov)
      var halfV = vaov / 2;
      cfg.minPitch = -(halfV - 2);
      cfg.maxPitch = (halfV - 2);
    }
    return cfg;
  }

  // Called after image loads to store aspect ratio on scene
  function measureAndSaveAspect(scene, project, imgSrc) {
    var img = new Image();
    img.onload = function() {
      var ratio = img.naturalWidth / img.naturalHeight;
      if (ratio > 0 && ratio !== scene.aspectRatio) {
        scene.aspectRatio = ratio;
        saveProject(project);
      }
    };
    img.src = imgSrc;
  }

  function exportProject(projId) {
    const proj = getProject(projId);
    if (!proj) { alert("Project not found."); return; }
    const bundle = { version: 1, project: JSON.parse(JSON.stringify(proj)), images: {} };
    proj.scenes.forEach(s => { const img = getImg(s.id); if (img) bundle.images[s.id] = img; });
    const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (proj.name.replace(/[^a-z0-9]/gi, "_") || "project") + ".glory360";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.Glory360 = {
    uid, saveImg, getImg, delImg, resolveUrl,
    getProjects, saveProjects, getProject, saveProject, createProject, deleteProject,
    getQueryParam, hs2cfg, panoConfig, measureAndSaveAspect, exportProject
  };

  // ── Index page ──
  document.addEventListener("DOMContentLoaded", function () {
    const projList = document.getElementById("project-list");
    if (!projList) return;
    const projCount = document.getElementById("project-count");
    const nameInput = document.getElementById("project-name");
    const createBtn = document.getElementById("create-project-btn");
    const importBtn = document.getElementById("import-btn");
    const importModal = document.getElementById("import-modal");
    const importFile = document.getElementById("import-file");
    const importDrop = document.getElementById("import-drop");
    const importFn   = document.getElementById("import-fn");
    const importMsg  = document.getElementById("import-msg");
    const importConfirm = document.getElementById("import-confirm-btn");
    const importCancel  = document.getElementById("import-cancel-btn");
    let importParsed = null;

    function render() {
      const ps = getProjects();
      projCount.textContent = ps.length + " saved";
      projList.innerHTML = "";
      if (!ps.length) {
        projList.innerHTML = '<div class="empty-state"><span class="empty-icon">&#127760;</span><p>No projects yet. Create one above.</p></div>';
        return;
      }
      ps.forEach(proj => {
        const row = document.createElement("article"); row.className = "project-row";
        const info = document.createElement("div");
        const nm = document.createElement("div"); nm.className = "project-name"; nm.textContent = proj.name;
        const det = document.createElement("div"); det.className = "muted";
        det.textContent = proj.scenes.length + " scene" + (proj.scenes.length === 1 ? "" : "s");
        info.append(nm, det);
        const acts = document.createElement("div"); acts.className = "project-actions";
        const eb = document.createElement("a"); eb.className = "button"; eb.textContent = "Edit";
        eb.href = "editor.html?project=" + encodeURIComponent(proj.id);
        const vb = document.createElement("a"); vb.className = "btn-ghost button"; vb.textContent = "View";
        vb.href = "viewer.html?project=" + encodeURIComponent(proj.id);
        if (!proj.scenes.length) { vb.style.opacity = "0.4"; vb.style.pointerEvents = "none"; }
        const xb = document.createElement("button"); xb.className = "btn-ghost"; xb.textContent = "Export";
        xb.onclick = () => exportProject(proj.id);
        const db = document.createElement("button"); db.className = "text-button danger"; db.textContent = "Delete";
        db.onclick = () => { if (confirm('Delete "' + proj.name + '"?')) { proj.scenes.forEach(s => delImg(s.id)); deleteProject(proj.id); render(); } };
        acts.append(eb, vb, xb, db); row.append(info, acts); projList.appendChild(row);
      });
    }

    createBtn.onclick = function () {
      const nm = nameInput.value.trim(); if (!nm) { nameInput.focus(); return; }
      const p = createProject(nm); nameInput.value = "";
      window.location.href = "editor.html?project=" + encodeURIComponent(p.id);
    };
    nameInput.onkeydown = e => { if (e.key === "Enter") createBtn.click(); };

    importBtn.onclick = () => {
      importParsed = null; importFn.style.display = "none"; importMsg.style.display = "none";
      importConfirm.disabled = true; importFile.value = ""; importModal.style.display = "flex";
    };
    importCancel.onclick = () => { importModal.style.display = "none"; };
    importModal.onclick = e => { if (e.target === importModal) importModal.style.display = "none"; };

    function handleImportFile(file) {
      if (!file) return;
      importFn.textContent = file.name; importFn.style.display = "block";
      const fr = new FileReader();
      fr.onload = function (e) {
        try {
          const bundle = JSON.parse(e.target.result);
          if (!bundle.project || !bundle.project.scenes) throw new Error("Invalid file format");
          importParsed = bundle;
          importMsg.textContent = 'Ready: "' + bundle.project.name + '" (' + bundle.project.scenes.length + ' scenes)';
          importMsg.style.cssText = "display:block;color:var(--success)";
          importConfirm.disabled = false;
        } catch (err) {
          importMsg.textContent = "Error: " + err.message;
          importMsg.style.cssText = "display:block;color:var(--danger)";
          importParsed = null; importConfirm.disabled = true;
        }
      };
      fr.readAsText(file);
    }
    importFile.onchange = () => handleImportFile(importFile.files[0]);
    importDrop.ondragover = e => { e.preventDefault(); importDrop.classList.add("dragover"); };
    importDrop.ondragleave = () => importDrop.classList.remove("dragover");
    importDrop.ondrop = e => { e.preventDefault(); importDrop.classList.remove("dragover"); handleImportFile(e.dataTransfer.files[0]); };

    importConfirm.onclick = function () {
      if (!importParsed) return;
      const orig = JSON.parse(JSON.stringify(importParsed));
      const proj = orig.project;
      const sceneIdMap = {};
      proj.scenes.forEach(s => { const nid = uid("scene"); sceneIdMap[s.id] = nid; s.id = nid; });
      proj.id = uid("proj");
      proj.scenes.forEach(s => {
        s.hotspots.forEach(h => { h.id = uid("hs"); if (sceneIdMap[h.targetSceneId]) h.targetSceneId = sceneIdMap[h.targetSceneId]; });
      });
      if (orig.images) { Object.keys(sceneIdMap).forEach(oldId => { if (orig.images[oldId]) saveImg(sceneIdMap[oldId], orig.images[oldId]); }); }
      const ps = getProjects(); ps.unshift(proj); saveProjects(ps);
      importModal.style.display = "none"; render();
      alert('Imported "' + proj.name + '" successfully!');
    };
    render();
  });
})();
