(function () {
  "use strict";

  var G = window.Glory360;
  var project = null, selSceneId = null, viewer = null;
  var hsMode = false, pendingImg = null, selType = "sphere";
  var pendingRelocateId = null, dragState = null;

  var projectId = G.getQueryParam("project");

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    project = G.getProject(projectId);
    if (!project) { setStatus("Project not found."); return; }

    selSceneId = project.scenes[0] ? project.scenes[0].id : null;
    document.getElementById("project-title").textContent = project.name;
    document.title = "Glory360 — " + project.name;
    document.getElementById("viewer-link").href = "viewer.html?project=" + encodeURIComponent(project.id);
    document.getElementById("export-btn").onclick = function () { G.exportProject(project.id); };

    // Type toggle
    document.querySelectorAll("input[name=sType]").forEach(function (r) {
      r.onchange = function () {
        selType = this.value;
        document.getElementById("opt-sphere").classList.toggle("sel", selType === "sphere");
        document.getElementById("opt-pano").classList.toggle("sel", selType === "panorama");
      };
    });

    // File upload
    var sceneFile = document.getElementById("scene-file");
    sceneFile.onchange = function () { if (sceneFile.files[0]) loadFile(sceneFile.files[0]); };
    var ua = document.getElementById("upload-area");
    ua.ondragover  = function (e) { e.preventDefault(); ua.classList.add("dragover"); };
    ua.ondragleave = function () { ua.classList.remove("dragover"); };
    ua.ondrop = function (e) {
      e.preventDefault(); ua.classList.remove("dragover");
      var f = e.dataTransfer.files[0]; if (f && f.type.startsWith("image/")) loadFile(f);
    };
    document.getElementById("clear-img").onclick = clearImgPreview;
    document.getElementById("add-scene-btn").onclick = addScene;
    document.getElementById("add-hs-btn").onclick = toggleHsMode;
    document.getElementById("ed-pano").addEventListener("click", onPanoClick, true);

    render();
  }

  // ── File helpers ──────────────────────────────────────────────
  function loadFile(file) {
    var fr = new FileReader();
    fr.onload = function (e) {
      pendingImg = e.target.result;
      document.getElementById("preview-img").src = pendingImg;
      document.getElementById("img-preview").style.display = "block";
      document.getElementById("upload-fn").textContent = file.name;
      document.getElementById("upload-fn").style.display = "block";
      document.getElementById("scene-url").value = "";
    };
    fr.readAsDataURL(file);
  }
  function clearImgPreview() {
    pendingImg = null;
    document.getElementById("preview-img").src = "";
    document.getElementById("img-preview").style.display = "none";
    document.getElementById("upload-fn").style.display = "none";
    document.getElementById("scene-file").value = "";
  }

  // ── Add scene — async (saveImg returns Promise) ───────────────
  function addScene() {
    var name = document.getElementById("scene-name").value.trim() || "Scene " + (project.scenes.length + 1);
    var src  = pendingImg || document.getElementById("scene-url").value.trim();
    if (!src) { setStatus("Upload an image or paste a URL first."); return; }

    var scene = { id: G.uid("scene"), name: name, imageUrl: pendingImg ? "" : src, sceneType: selType, hotspots: [] };
    var savePromise = pendingImg ? G.saveImg(scene.id, pendingImg) : Promise.resolve();

    setStatus("Saving scene…");
    savePromise.then(function () {
      project.scenes.push(scene);
      selSceneId = scene.id; hsMode = false; pendingImg = null;
      if (selType === "panorama") G.measureAndSaveAspect(scene, project, src);
      project = G.saveProject(project);
      document.getElementById("scene-name").value = "";
      document.getElementById("scene-url").value = "";
      clearImgPreview();
      render();
      setStatus("Scene \"" + scene.name + "\" added.");
    }).catch(function (err) {
      setStatus("Failed to save image: " + err.message);
    });
  }

  // ── Hotspot mode ──────────────────────────────────────────────
  function toggleHsMode() {
    var sel = getSelScene();
    if (!sel) { setStatus("Select a scene first."); return; }
    if (!document.getElementById("target-scene").value) { setStatus("Add at least 2 scenes to link between them."); return; }
    hsMode = !hsMode; pendingRelocateId = null;
    renderHsControls();
    if (hsMode) { setStatus("Click anywhere on the panorama to place the hotspot."); showHint("Click on the panorama to place hotspot"); }
    else { setStatus("Hotspot placement cancelled."); hideHint(); }
  }

  function onPanoClick(e) {
    if (!viewer) return;
    var onHotspot = e.target.closest(".pnlm-hotspot");
    if (onHotspot && !pendingRelocateId) return;

    if (pendingRelocateId) {
      if (onHotspot) return;
      var coords = viewer.mouseEventToCoords(e);
      var sel = getSelScene();
      var hs  = sel && sel.hotspots.find(function (h) { return h.id === pendingRelocateId; });
      if (hs) {
        hs.pitch = +coords[0].toFixed(2); hs.yaw = +coords[1].toFixed(2);
        project = G.saveProject(project);
        pendingRelocateId = null;
        renderPano(); hideHint();
        setStatus("Hotspot moved to " + hs.pitch + "°, " + hs.yaw + "°.");
      }
      return;
    }

    if (!hsMode) return;
    var tgtId = document.getElementById("target-scene").value;
    var tgt   = project.scenes.find(function (s) { return s.id === tgtId; });
    if (!tgt) { setStatus("Choose a target scene."); return; }
    var coords2 = viewer.mouseEventToCoords(e);
    var newHs = { id: G.uid("hs"), pitch: +coords2[0].toFixed(2), yaw: +coords2[1].toFixed(2), targetSceneId: tgtId, label: "Go to " + tgt.name };
    getSelScene().hotspots.push(newHs);
    hsMode = false; project = G.saveProject(project);
    viewer.addHotSpot(G.hs2cfg(project, newHs, true));
    setTimeout(function () { attachDragToHotspot(newHs.id); }, 150);
    renderSceneList(); renderHsControls(); hideHint();
    setStatus("Hotspot placed — drag it to reposition, or use the Move button.");
  }

  // ── Draggable hotspots ────────────────────────────────────────
  function getLabelForHs(hsId) {
    var sel = getSelScene(); if (!sel) return "";
    var hs  = sel.hotspots.find(function (h) { return h.id === hsId; }); if (!hs) return "";
    var tgt = project.scenes.find(function (s) { return s.id === hs.targetSceneId; });
    return tgt ? "Go to " + tgt.name : "Hotspot";
  }

  function attachDragToHotspot(hsId) {
    var panoEl = document.getElementById("ed-pano");
    var el = panoEl.querySelector("[data-hs-id='" + hsId + "']");
    if (!el) {
      var label = getLabelForHs(hsId);
      panoEl.querySelectorAll(".pnlm-hotspot").forEach(function (node) {
        var tip = node.querySelector(".pnlm-tooltip");
        if (tip && tip.textContent.trim() === label) el = node;
      });
    }
    if (!el) return;
    el.dataset.hsId = hsId;
    el.classList.add("hs-draggable");
    el.addEventListener("mousedown", function (e) { startDrag(e, hsId); }, true);
    el.addEventListener("touchstart", function (e) { startDrag(e.touches[0], hsId); e.preventDefault(); }, { passive: false });
  }

  function attachDragToAll() {
    var sel = getSelScene(); if (!sel || !viewer) return;
    setTimeout(function () { sel.hotspots.forEach(function (hs) { attachDragToHotspot(hs.id); }); }, 200);
  }

  function startDrag(e, hsId) {
    e.stopPropagation();
    dragState = { hsId: hsId, startX: e.clientX, startY: e.clientY, moved: false };
    var el = document.getElementById("ed-pano").querySelector("[data-hs-id='" + hsId + "']");
    if (el) el.classList.add("hs-dragging");
    showHint("Release to drop hotspot here");
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup",   onDragEnd,  true);
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    document.addEventListener("touchend",  onTouchEnd,  true);
  }
  function onDragMove(e) {
    if (!dragState) return;
    if (Math.abs(e.clientX - dragState.startX) > 3 || Math.abs(e.clientY - dragState.startY) > 3) dragState.moved = true;
    dragState.lastX = e.clientX; dragState.lastY = e.clientY;
  }
  function onTouchMove(e) { if (dragState) { e.preventDefault(); onDragMove(e.touches[0]); } }
  function onDragEnd(e)   { finishDrag(e.clientX, e.clientY); }
  function onTouchEnd(e)  { if (dragState) finishDrag(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }

  function finishDrag(clientX, clientY) {
    if (!dragState) return;
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup",   onDragEnd,  true);
    document.removeEventListener("touchmove", onTouchMove, true);
    document.removeEventListener("touchend",  onTouchEnd,  true);
    var panoEl = document.getElementById("ed-pano");
    var el = panoEl.querySelector("[data-hs-id='" + dragState.hsId + "']");
    if (el) el.classList.remove("hs-dragging");
    if (dragState.moved && viewer) {
      try {
        var coords = viewer.mouseEventToCoords({ clientX: clientX, clientY: clientY, target: panoEl });
        var sel = getSelScene();
        var hs  = sel && sel.hotspots.find(function (h) { return h.id === dragState.hsId; });
        if (hs) {
          hs.pitch = +coords[0].toFixed(2); hs.yaw = +coords[1].toFixed(2);
          project  = G.saveProject(project);
          renderPano();
          setStatus("Hotspot moved to " + hs.pitch + "°, " + hs.yaw + "°.");
        }
      } catch (err) { renderPano(); }
    }
    dragState = null; hideHint();
  }

  // ── Hint bar ──────────────────────────────────────────────────
  function showHint(msg) {
    var pano = document.getElementById("ed-pano");
    var h    = document.getElementById("hs-drag-hint");
    if (!h) { h = document.createElement("div"); h.id = "hs-drag-hint"; h.className = "hs-drag-hint"; pano.appendChild(h); }
    h.textContent = msg; h.style.opacity = "1";
  }
  function hideHint() {
    var h = document.getElementById("hs-drag-hint");
    if (h) { h.style.opacity = "0"; setTimeout(function () { if (h.parentNode) h.parentNode.removeChild(h); }, 450); }
  }

  // ── Render ────────────────────────────────────────────────────
  function render() { renderSceneList(); renderHsControls(); renderPano(); }

  function renderSceneList() {
    var list = document.getElementById("scene-list");
    var cnt  = document.getElementById("scene-count");
    list.innerHTML = ""; cnt.textContent = project.scenes.length + " total";
    if (!project.scenes.length) {
      list.innerHTML = '<div class="empty-state"><span class="empty-icon">&#127760;</span><p>No scenes yet.</p></div>';
      return;
    }
    project.scenes.forEach(function (scene) {
      var btn = document.createElement("button");
      btn.className = "scene-row" + (scene.id === selSceneId ? " active" : "");
      btn.type = "button";
      var top = document.createElement("div"); top.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:7px";
      var nm  = document.createElement("div"); nm.className = "scene-name"; nm.textContent = scene.name;
      var bdg = document.createElement("span"); bdg.className = "s-badge " + (scene.sceneType === "panorama" ? "s-pano" : "s-sphere");
      bdg.textContent = scene.sceneType === "panorama" ? "Panorama" : "360°";
      top.append(nm, bdg);
      var det  = document.createElement("div"); det.className = "muted"; det.textContent = scene.hotspots.length + " hotspot" + (scene.hotspots.length === 1 ? "" : "s");
      var delb = document.createElement("button"); delb.className = "text-button danger"; delb.type = "button"; delb.textContent = "Remove"; delb.style.marginTop = "5px";
      delb.onclick = function (ev) {
        ev.stopPropagation();
        if (!confirm("Remove \"" + scene.name + "\"?")) return;
        G.delImg(scene.id);
        project.scenes = project.scenes.filter(function (s) { return s.id !== scene.id; });
        if (selSceneId === scene.id) selSceneId = project.scenes[0] ? project.scenes[0].id : null;
        project = G.saveProject(project); render(); setStatus("Scene removed.");
      };
      btn.append(top, det, delb);
      btn.onclick = function () { selSceneId = scene.id; hsMode = false; pendingRelocateId = null; render(); setStatus("Editing \"" + scene.name + "\"."); };
      list.appendChild(btn);
    });
  }

  function renderHsControls() {
    var sel    = getSelScene();
    var ts     = document.getElementById("target-scene");
    var hslist = document.getElementById("hs-list");
    var addbtn = document.getElementById("add-hs-btn");
    ts.innerHTML = ""; hslist.innerHTML = "";
    if (!sel) { ts.disabled = true; addbtn.disabled = true; addbtn.classList.remove("armed"); return; }
    var targets = project.scenes.filter(function (s) { return s.id !== sel.id; });
    targets.forEach(function (s) { var o = document.createElement("option"); o.value = s.id; o.textContent = s.name; ts.appendChild(o); });
    ts.disabled = !targets.length; addbtn.disabled = !targets.length;
    addbtn.textContent = hsMode ? "● Click Panorama to Place" : "+ Add Hotspot by Click";
    addbtn.classList.toggle("armed", hsMode);
    if (!sel.hotspots.length) { hslist.innerHTML = "<p class='muted' style='padding:3px 0'>No hotspots yet.</p>"; return; }
    sel.hotspots.forEach(function (hs) {
      var tgt  = project.scenes.find(function (s) { return s.id === hs.targetSceneId; });
      var row  = document.createElement("div"); row.className = "hs-row";
      var info = document.createElement("div");
      info.innerHTML = "<div style='font-size:.79rem'>" + (tgt ? hs.label : hs.label + " &#9888;") + "</div><div class='muted'>" + hs.pitch + "°, " + hs.yaw + "°</div>";
      var mvb = document.createElement("button"); mvb.className = "btn-ghost"; mvb.style.cssText = "min-height:28px;padding:0 9px;font-size:.72rem"; mvb.textContent = "Move"; mvb.type = "button";
      mvb.onclick = function () {
        pendingRelocateId = hs.id; hsMode = false;
        showHint("Click on the panorama where you want to move this hotspot");
        setStatus("Click on the panorama to move \"" + hs.label + "\".");
      };
      var rb = document.createElement("button"); rb.className = "text-button danger"; rb.textContent = "✕"; rb.type = "button";
      rb.onclick = function () {
        sel.hotspots = sel.hotspots.filter(function (h) { return h.id !== hs.id; });
        project = G.saveProject(project); render(); setStatus("Hotspot removed.");
      };
      row.append(info, mvb, rb); hslist.appendChild(row);
    });
  }

  // renderPano is now async — panoConfig returns a Promise
  function renderPano() {
    destroyViewer();
    var box = document.getElementById("ed-pano");
    box.innerHTML = ""; box.className = "panorama-box";
    var sel = getSelScene();
    if (!sel) {
      box.classList.add("empty");
      box.innerHTML = "<span class='pano-empty-icon'>&#127760;</span><span style='font-size:.84rem'>Add a scene to start editing</span>";
      return;
    }
    if (!window.pannellum) {
      box.classList.add("empty");
      box.innerHTML = "<span class='pano-empty-icon'>&#9888;</span><span>Pannellum failed to load — check internet connection</span>";
      return;
    }
    // Show loading state while image resolves from IndexedDB
    box.classList.add("empty");
    box.innerHTML = "<span class='pano-empty-icon' style='opacity:.4'>&#8987;</span><span style='font-size:.82rem;color:var(--light-muted)'>Loading image…</span>";

    G.panoConfig(sel, project, true).then(function (cfg) {
      if (!cfg.panorama) {
        box.innerHTML = "<span class='pano-empty-icon'>&#128444;</span><span style='font-size:.84rem'>No image — upload one or paste a URL</span>";
        return;
      }
      box.innerHTML = ""; box.className = "panorama-box";
      var wrap = document.createElement("div"); wrap.style.cssText = "width:100%;height:100%"; box.appendChild(wrap);
      viewer = pannellum.viewer(wrap, cfg);
      attachDragToAll();
      setStatus("Editing \"" + sel.name + "\" (" + (sel.sceneType === "panorama" ? "Wide Panorama" : "360 Sphere") + "). Place or drag hotspots.");
    }).catch(function (err) {
      box.innerHTML = "<span class='pano-empty-icon'>&#9888;</span><span style='font-size:.82rem'>Failed to load image: " + err.message + "</span>";
    });
  }

  function destroyViewer() {
    if (viewer && typeof viewer.destroy === "function") { try { viewer.destroy(); } catch (e) {} viewer = null; }
  }
  function getSelScene() { return project ? project.scenes.find(function (s) { return s.id === selSceneId; }) || null : null; }
  function setStatus(m)  { var el = document.getElementById("ed-status"); if (el) el.textContent = m; }
})();
