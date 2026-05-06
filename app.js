(function () {
  "use strict";

  // ── Storage keys ─────────────────────────────────────────────
  const SK      = "glory360.v3";       // localStorage — project metadata
  const DB_NAME = "glory360_images";   // IndexedDB — image blobs
  const DB_VER  = 1;
  const DB_STORE = "images";
  const IK_OLD  = "glory360.img.";     // old localStorage image prefix (migration)

  // ── Unique ID ─────────────────────────────────────────────────
  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  }

  // ════════════════════════════════════════════════════════════
  //  IndexedDB — image storage (50-200MB vs 5MB localStorage)
  //  All image functions are async/Promise-based.
  //  Project metadata (text) stays in localStorage — it's tiny.
  // ════════════════════════════════════════════════════════════

  var _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = function (e) {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  // Save image dataUrl to IndexedDB
  function saveImg(id, dataUrl) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(DB_STORE, "readwrite");
        var req = tx.objectStore(DB_STORE).put(dataUrl, id);
        req.onsuccess = function () { resolve(); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    }).catch(function (err) {
      console.error("saveImg failed:", err);
      alert("Image could not be saved. Storage may be full.");
    });
  }

  // Get image dataUrl from IndexedDB — returns Promise<string|null>
  function getImg(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(DB_STORE, "readonly");
        var req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = function (e) { resolve(e.target.result || null); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    }).catch(function () { return null; });
  }

  // Delete image from IndexedDB
  function delImg(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
      });
    }).catch(function () {});
  }

  // Get ALL image keys from IndexedDB — used for export
  function getAllImgKeys() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(DB_STORE, "readonly");
        var req = tx.objectStore(DB_STORE).getAllKeys();
        req.onsuccess = function (e) { resolve(e.target.result || []); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    }).catch(function () { return []; });
  }

  // ── Migrate old localStorage images to IndexedDB (one-time) ──
  function migrateFromLocalStorage() {
    var migrated = 0;
    var promises = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf(IK_OLD) === 0) {
        var sceneId  = key.slice(IK_OLD.length);
        var dataUrl  = localStorage.getItem(key);
        if (dataUrl) {
          promises.push(
            saveImg(sceneId, dataUrl).then((function (k) {
              return function () {
                localStorage.removeItem(k);
                migrated++;
              };
            })(key))
          );
        }
      }
    }
    if (promises.length) {
      Promise.all(promises).then(function () {
        if (migrated > 0) console.log("Glory360: migrated " + migrated + " image(s) from localStorage to IndexedDB.");
      });
    }
  }

  // resolveUrl now returns a Promise<string>
  function resolveUrl(scene) {
    if (scene.imageUrl) return Promise.resolve(scene.imageUrl);
    return getImg(scene.id).then(function (data) {
      return data || "";
    });
  }

  // ── Project metadata (localStorage — text only, tiny) ────────
  function getProjects() {
    try {
      var r = localStorage.getItem(SK);
      var p = r ? JSON.parse(r) : [];
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }
  function saveProjects(p) { localStorage.setItem(SK, JSON.stringify(p)); }
  function getProject(id) { return getProjects().find(function (p) { return p.id === id; }) || null; }
  function saveProject(proj) {
    var ps = getProjects();
    var i  = ps.findIndex(function (p) { return p.id === proj.id; });
    if (i === -1) ps.unshift(proj); else ps[i] = proj;
    saveProjects(ps); return proj;
  }
  function createProject(name) {
    var p  = { id: uid("proj"), name: name.trim() || "Untitled", scenes: [] };
    var ps = getProjects(); ps.unshift(p); saveProjects(ps); return p;
  }
  function deleteProject(id) { saveProjects(getProjects().filter(function (p) { return p.id !== id; })); }
  function getQueryParam(name) { return new URLSearchParams(window.location.search).get(name); }

  // ── Pannellum helpers ─────────────────────────────────────────
  function hs2cfg(proj, hs, edMode) {
    var tgt = proj.scenes.find(function (s) { return s.id === hs.targetSceneId; });
    var lbl = hs.label || (tgt ? "Go to " + tgt.name : "Hotspot");
    var c   = { pitch: hs.pitch, yaw: hs.yaw, text: lbl };
    if (edMode) { c.type = "info"; } else { c.type = "scene"; c.sceneId = hs.targetSceneId; }
    return c;
  }

  // panoConfig now returns a Promise<config>
  function panoConfig(scene, project, edMode) {
    return resolveUrl(scene).then(function (imageUrl) {
      var cfg = {
        type: "equirectangular", panorama: imageUrl,
        autoLoad: true, showFullscreenCtrl: false, showZoomCtrl: true,
        hotSpots: scene.hotspots
          .filter(function (h) { return project.scenes.find(function (s) { return s.id === h.targetSceneId; }); })
          .map(function (h) { return hs2cfg(project, h, edMode); })
      };
      if (scene.sceneType === "panorama") {
        var aspect = scene.aspectRatio || 4;
        var haov   = 360;
        var vaov   = haov / aspect;
        if (vaov > 150) vaov = 150;
        cfg.haov     = haov;
        cfg.vaov     = vaov;
        cfg.pitch    = 0; cfg.yaw = 0;
        cfg.hfov     = 90; cfg.minHfov = 40; cfg.maxHfov = 120;
        var halfV    = vaov / 2;
        cfg.minPitch = -(halfV - 2);
        cfg.maxPitch = (halfV - 2);
      }
      return cfg;
    });
  }

  // Measure and save aspect ratio for panorama scenes
  function measureAndSaveAspect(scene, project, imgSrc) {
    var img = new Image();
    img.onload = function () {
      var ratio = img.naturalWidth / img.naturalHeight;
      if (ratio > 0 && ratio !== scene.aspectRatio) {
        scene.aspectRatio = ratio;
        saveProject(project);
      }
    };
    img.src = imgSrc;
  }

  // ── Export — reads images from IndexedDB ──────────────────────
  function exportProject(projId) {
    var proj = getProject(projId);
    if (!proj) { alert("Project not found."); return; }

    var sceneIds    = proj.scenes.map(function (s) { return s.id; });
    var imgPromises = sceneIds.map(function (id) { return getImg(id); });

    Promise.all(imgPromises).then(function (images) {
      var bundle = { version: 2, project: JSON.parse(JSON.stringify(proj)), images: {} };
      sceneIds.forEach(function (id, i) {
        if (images[i]) bundle.images[id] = images[i];
      });

      var filename = (proj.name.replace(/[^a-z0-9]/gi, "_") || "project") + ".glory360";
      var json     = JSON.stringify(bundle);

      // ── Android APK WebView bridge ───────────────────────────
      // If the Java download bridge is available (injected by MainActivity),
      // use it to write directly to the Downloads folder on the device.
      if (window.AndroidBridge && typeof window.AndroidBridge.saveFile === "function") {
        try {
          window.AndroidBridge.saveFile(filename, json);
          return;
        } catch (e) {
          console.warn("AndroidBridge.saveFile failed, falling back:", e);
        }
      }

      // ── Chrome / browser fallback — base64 data URI ──────────
      // URL.createObjectURL is unreliable in WebView sandboxes.
      // data: URI with base64 content works in Chrome and most browsers.
      try {
        var b64  = btoa(unescape(encodeURIComponent(json)));
        var uri  = "data:application/octet-stream;base64," + b64;
        var a    = document.createElement("a");
        a.href   = uri;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e) {
        // Last resort — open as text in a new tab so user can save manually
        var w = window.open("", "_blank");
        if (w) {
          w.document.write("<pre style='word-break:break-all;font-size:11px'>" + json + "</pre>");
          w.document.title = filename;
        } else {
          alert("Download failed. Please enable pop-ups or check Downloads folder.");
        }
      }
    }).catch(function (err) {
      alert("Export failed: " + err.message);
    });
  }

  // ── Expose public API ─────────────────────────────────────────
  window.Glory360 = {
    uid, saveImg, getImg, delImg, resolveUrl,
    getProjects, saveProjects, getProject, saveProject, createProject, deleteProject,
    getQueryParam, hs2cfg, panoConfig, measureAndSaveAspect, exportProject
  };

  // Run migration on every page load (safe to call repeatedly — removes keys as it goes)
  migrateFromLocalStorage();

  // ══════════════════════════════════════════════════════════════
  //  INDEX PAGE
  // ══════════════════════════════════════════════════════════════
  document.addEventListener("DOMContentLoaded", function () {
    var projList = document.getElementById("project-list");
    if (!projList) return;

    var projCount    = document.getElementById("project-count");
    var nameInput    = document.getElementById("project-name");
    var createBtn    = document.getElementById("create-project-btn");
    var importBtn    = document.getElementById("import-btn");
    var importModal  = document.getElementById("import-modal");
    var importFile   = document.getElementById("import-file");
    var importDrop   = document.getElementById("import-drop");
    var importFn     = document.getElementById("import-fn");
    var importMsg    = document.getElementById("import-msg");
    var importConfirm = document.getElementById("import-confirm-btn");
    var importCancel  = document.getElementById("import-cancel-btn");
    var importParsed  = null;

    function render() {
      var ps = getProjects();
      projCount.textContent = ps.length + " saved";
      projList.innerHTML = "";
      if (!ps.length) {
        projList.innerHTML = '<div class="empty-state"><span class="empty-icon">&#127760;</span><p>No projects yet. Create one above.</p></div>';
        return;
      }
      ps.forEach(function (proj) {
        var row  = document.createElement("article"); row.className = "project-row";
        var info = document.createElement("div");
        var nm   = document.createElement("div"); nm.className = "project-name"; nm.textContent = proj.name;
        var det  = document.createElement("div"); det.className = "muted";
        det.textContent = proj.scenes.length + " scene" + (proj.scenes.length === 1 ? "" : "s");
        info.append(nm, det);
        var acts = document.createElement("div"); acts.className = "project-actions";
        var eb   = document.createElement("a"); eb.className = "button"; eb.textContent = "Edit";
        eb.href  = "editor.html?project=" + encodeURIComponent(proj.id);
        var vb   = document.createElement("a"); vb.className = "btn-ghost button"; vb.textContent = "View";
        vb.href  = "viewer.html?project=" + encodeURIComponent(proj.id);
        if (!proj.scenes.length) { vb.style.opacity = "0.4"; vb.style.pointerEvents = "none"; }
        var xb   = document.createElement("button"); xb.className = "btn-ghost"; xb.textContent = "Export";
        xb.onclick = function () { exportProject(proj.id); };
        var db   = document.createElement("button"); db.className = "text-button danger"; db.textContent = "Delete";
        db.onclick = function () {
          if (!confirm('Delete "' + proj.name + '"?')) return;
          var delPromises = proj.scenes.map(function (s) { return delImg(s.id); });
          Promise.all(delPromises).then(function () { deleteProject(proj.id); render(); });
        };
        acts.append(eb, vb, xb, db); row.append(info, acts); projList.appendChild(row);
      });
    }

    createBtn.onclick = function () {
      var nm = nameInput.value.trim(); if (!nm) { nameInput.focus(); return; }
      var p  = createProject(nm); nameInput.value = "";
      window.location.href = "editor.html?project=" + encodeURIComponent(p.id);
    };
    nameInput.onkeydown = function (e) { if (e.key === "Enter") createBtn.click(); };

    // Import modal
    importBtn.onclick = function () {
      importParsed = null; importFn.style.display = "none"; importMsg.style.display = "none";
      importConfirm.disabled = true; importFile.value = ""; importModal.style.display = "flex";
    };
    importCancel.onclick = function () { importModal.style.display = "none"; };
    importModal.onclick  = function (e) { if (e.target === importModal) importModal.style.display = "none"; };

    function handleImportFile(file) {
      if (!file) return;
      importFn.textContent = file.name; importFn.style.display = "block";
      var fr = new FileReader();
      fr.onload = function (e) {
        try {
          var bundle = JSON.parse(e.target.result);
          if (!bundle.project || !bundle.project.scenes) throw new Error("Invalid file format");
          importParsed = bundle;
          importMsg.textContent = 'Ready: "' + bundle.project.name + '" (' + bundle.project.scenes.length + " scenes)";
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
    importFile.onchange  = function () { handleImportFile(importFile.files[0]); };
    importDrop.ondragover = function (e) { e.preventDefault(); importDrop.classList.add("dragover"); };
    importDrop.ondragleave = function () { importDrop.classList.remove("dragover"); };
    importDrop.ondrop = function (e) {
      e.preventDefault(); importDrop.classList.remove("dragover");
      handleImportFile(e.dataTransfer.files[0]);
    };

    importConfirm.onclick = function () {
      if (!importParsed) return;
      importConfirm.disabled = true;
      importConfirm.textContent = "Importing…";
      var orig = JSON.parse(JSON.stringify(importParsed));
      var proj = orig.project;
      var sceneIdMap = {};
      proj.scenes.forEach(function (s) { var nid = uid("scene"); sceneIdMap[s.id] = nid; s.id = nid; });
      proj.id = uid("proj");
      proj.scenes.forEach(function (s) {
        s.hotspots.forEach(function (h) {
          h.id = uid("hs");
          if (sceneIdMap[h.targetSceneId]) h.targetSceneId = sceneIdMap[h.targetSceneId];
        });
      });
      // Save images to IndexedDB
      var imgPromises = [];
      if (orig.images) {
        Object.keys(sceneIdMap).forEach(function (oldId) {
          if (orig.images[oldId]) {
            imgPromises.push(saveImg(sceneIdMap[oldId], orig.images[oldId]));
          }
        });
      }
      Promise.all(imgPromises).then(function () {
        var ps = getProjects(); ps.unshift(proj); saveProjects(ps);
        importModal.style.display = "none";
        importConfirm.textContent = "Import";
        render();
        alert('Imported "' + proj.name + '" successfully!');
      }).catch(function (err) {
        alert("Import failed: " + err.message);
        importConfirm.disabled = false;
        importConfirm.textContent = "Import";
      });
    };

    render();
  });
})();
