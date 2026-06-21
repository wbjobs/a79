const API_BASE = window.location.origin;
const WS_BASE = window.location.origin.replace('http', 'ws');

const App = {
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    pointCloud: null,
    pointGeometry: null,
    pointMaterial: null,
    baseColors: null,
    pointData: null,
    annotations: {},
    tags: [],
    selectedTag: null,
    users: [],
    me: null,
    mode: 'point',
    ws: null,
    modelName: null,
    selectedPoints: new Set(),
    boxStart: null,
    isBoxSelecting: false,
    hoveredPoint: null,
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    mouseNormalized: new THREE.Vector2(),
    locks: {},
    lockMeshes: [],
    myLock: null,
    pendingLockPointIndex: null,
    lockCheckInterval: null,
    _lockAckCallback: null,
    semiAutoSeeds: {},
    segmentPreview: null,
    segmentPreviewColors: null,
    versions: [],

    init() {
        this.me = {
            user_id: localStorage.getItem('user_id') || this.genId(),
            username: localStorage.getItem('username') || '用户' + Math.floor(Math.random() * 1000),
            color: localStorage.getItem('user_color') || this.randomColor()
        };
        localStorage.setItem('user_id', this.me.user_id);
        localStorage.setItem('username', this.me.username);
        localStorage.setItem('user_color', this.me.color);
        document.getElementById('usernameInput').value = this.me.username;
        document.getElementById('userColorInput').value = this.me.color;

        this.initThree();
        this.bindUI();
        this.loadModels();
        this.animate();
    },

    initThree() {
        const container = document.getElementById('viewer');
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a1a);

        const rect = container.getBoundingClientRect();
        this.camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, 0.01, 1000);
        this.camera.position.set(2, 2, 3);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(rect.width, rect.height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(5, 10, 7);
        this.scene.add(dirLight);

        const gridHelper = new THREE.GridHelper(4, 20, 0x444444, 0x222222);
        this.scene.add(gridHelper);

        const axesHelper = new THREE.AxesHelper(1.5);
        this.scene.add(axesHelper);

        window.addEventListener('resize', () => this.onResize());
        this.setupSelectionHandlers();
    },

    setupSelectionHandlers() {
        const canvas = this.renderer.domElement;
        const selectionBox = document.getElementById('selectionBox');
        const viewer = document.getElementById('viewer');

        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (this.mode === 'box') {
                if (!e.shiftKey) {
                    this.selectedPoints.clear();
                    this.updatePointColors();
                }
                this.isBoxSelecting = true;
                this.boxStart = { x, y };
                selectionBox.style.left = x + 'px';
                selectionBox.style.top = y + 'px';
                selectionBox.style.width = '0px';
                selectionBox.style.height = '0px';
                selectionBox.classList.remove('hidden');
                this.controls.enabled = false;
            } else {
                if (!e.shiftKey) {
                    this.selectedPoints.clear();
                }
                this.pickPoint(e);
                this.updatePointColors();
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            this.updateMouseNDC(e);
            this.updateHoverPoint();

            if (this.isBoxSelecting && this.boxStart) {
                const left = Math.min(x, this.boxStart.x);
                const top = Math.min(y, this.boxStart.y);
                const width = Math.abs(x - this.boxStart.x);
                const height = Math.abs(y - this.boxStart.y);
                selectionBox.style.left = left + 'px';
                selectionBox.style.top = top + 'px';
                selectionBox.style.width = width + 'px';
                selectionBox.style.height = height + 'px';
            }
        });

        canvas.addEventListener('mouseup', (e) => {
            if (this.isBoxSelecting && this.boxStart) {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const startNDC = this.clientToNDC(this.boxStart.x, this.boxStart.y);
                const endNDC = this.clientToNDC(x, y);
                this.pickBoxPoints(startNDC, endNDC);
                this.updatePointColors();
                this.isBoxSelecting = false;
                this.boxStart = null;
                selectionBox.classList.add('hidden');
                this.controls.enabled = true;
            }
        });

        canvas.addEventListener('dblclick', (e) => {
            if (this.mode === 'point') {
                this.pickPoint(e, true);
                this.annotateSelectedPoints();
            }
        });
    },

    clientToNDC(clientX, clientY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return {
            x: ((clientX) / rect.width) * 2 - 1,
            y: -((clientY) / rect.height) * 2 + 1
        };
    },

    updateMouseNDC(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouseNormalized.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouseNormalized.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    },

    updateHoverPoint() {
        if (!this.pointCloud) return;
        this.raycaster.setFromCamera(this.mouseNormalized, this.camera);
        const intersects = this.raycaster.intersectObject(this.pointCloud);
        if (intersects.length > 0) {
            this.hoveredPoint = intersects[0].index;
            this.renderer.domElement.style.cursor = 'pointer';
        } else {
            this.hoveredPoint = null;
            this.renderer.domElement.style.cursor = 'default';
        }
    },

    isPointLockedByOther(pointIndex) {
        for (const lock of Object.values(this.locks)) {
            if (lock.user_id !== this.me.user_id && lock.locked_points.includes(pointIndex)) {
                return lock;
            }
        }
        return null;
    },

    pickPoint(e, replace = false) {
        if (!this.pointCloud) return;
        this.raycaster.setFromCamera(this.mouseNormalized, this.camera);
        const intersects = this.raycaster.intersectObject(this.pointCloud);
        if (intersects.length > 0) {
            const idx = intersects[0].index;
            if (this.mode === 'semiauto') {
                if (!this.selectedTag && this.tags.length > 0) {
                    this.selectedTag = this.tags[0].name;
                    this.renderTags();
                }
                if (!this.selectedTag) {
                    this.showToast('请先选择一个标签', true);
                    return;
                }
                this.addSemiAutoSeed(idx, this.selectedTag);
                return;
            }
            const lock = this.isPointLockedByOther(idx);
            if (lock) {
                this.showToast(`${lock.username} 正在标注这里，请稍候...`, true);
                return;
            }
            if (replace) {
                this.selectedPoints.clear();
            }
            if (this.selectedPoints.has(idx)) {
                this.selectedPoints.delete(idx);
            } else {
                this.selectedPoints.add(idx);
            }
            this.showToast(`已选择 ${this.selectedPoints.size} 个点`);
        }
    },

    pickBoxPoints(startNDC, endNDC) {
        if (!this.pointCloud || !this.pointData) return;
        const positions = this.pointData.positions;
        const minX = Math.min(startNDC.x, endNDC.x);
        const maxX = Math.max(startNDC.x, endNDC.x);
        const minY = Math.min(startNDC.y, endNDC.y);
        const maxY = Math.max(startNDC.y, endNDC.y);
        let skipped = 0;
        let added = 0;
        const v = new THREE.Vector3();
        const boxPoints = [];
        for (let i = 0; i < positions.length; i++) {
            v.set(positions[i][0], positions[i][1], positions[i][2]);
            v.project(this.camera);
            if (v.x >= minX && v.x <= maxX && v.y >= minY && v.y <= maxY) {
                if (this.mode !== 'semiauto' && this.isPointLockedByOther(i)) {
                    skipped++;
                    continue;
                }
                boxPoints.push(i);
            }
        }
        if (this.mode === 'semiauto') {
            if (!this.selectedTag && this.tags.length > 0) {
                this.selectedTag = this.tags[0].name;
                this.renderTags();
            }
            if (!this.selectedTag) {
                this.showToast('请先选择一个标签', true);
                return;
            }
            for (const idx of boxPoints) {
                this.addSemiAutoSeed(idx, this.selectedTag, true);
            }
            this.showToast(`已添加 ${boxPoints.length} 个种子点到「${this.selectedTag}」`);
        } else {
            for (const idx of boxPoints) {
                this.selectedPoints.add(idx);
            }
            let msg = `已选择 ${this.selectedPoints.size} 个点`;
            if (skipped > 0) {
                msg += `（跳过 ${skipped} 个被锁定的点）`;
            }
            this.showToast(msg);
        }
    },

    setMode(mode) {
        this.mode = mode;
        ['modePoint', 'modeBox', 'modeSemiAuto'].forEach(id => {
            document.getElementById(id).classList.remove('active');
        });
        if (mode === 'point') {
            document.getElementById('modePoint').classList.add('active');
        } else if (mode === 'box') {
            document.getElementById('modeBox').classList.add('active');
        } else if (mode === 'semiauto') {
            document.getElementById('modeSemiAuto').classList.add('active');
        }
        document.getElementById('semiAutoPanel').style.display = mode === 'semiauto' ? 'block' : 'none';
        if (mode !== 'semiauto') {
            this.cancelSegmentation();
        }
        this.updateSeedSummary();
        this.selectedPoints.clear();
        this.updatePointColors();
    },

    addSemiAutoSeed(pointIndex, label, batch = false) {
        if (!this.semiAutoSeeds[label]) {
            this.semiAutoSeeds[label] = [];
        }
        if (!this.semiAutoSeeds[label].includes(pointIndex)) {
            this.semiAutoSeeds[label].push(pointIndex);
            this.updatePointColors();
            if (!batch) {
                this.showToast(`已添加种子点到「${label}」 (${this.semiAutoSeeds[label].length})`);
            }
        } else {
            this.semiAutoSeeds[label] = this.semiAutoSeeds[label].filter(i => i !== pointIndex);
            if (this.semiAutoSeeds[label].length === 0) {
                delete this.semiAutoSeeds[label];
            }
            this.updatePointColors();
            if (!batch) {
                this.showToast(`已移除种子点`);
            }
        }
        this.updateSeedSummary();
    },

    clearSemiAutoSeeds() {
        this.semiAutoSeeds = {};
        this.segmentPreview = null;
        document.getElementById('previewPanel').style.display = 'none';
        this.updateSeedSummary();
        this.updatePointColors();
        this.showToast('种子点已清空');
    },

    updateSeedSummary() {
        const el = document.getElementById('seedSummary');
        const keys = Object.keys(this.semiAutoSeeds);
        if (keys.length === 0) {
            el.textContent = '暂无种子点';
            el.style.color = '#aaa';
            return;
        }
        const tagColorMap = {};
        for (const tag of this.tags) {
            tagColorMap[tag.name] = tag.color;
        }
        let html = '';
        let total = 0;
        for (const label of keys) {
            const count = this.semiAutoSeeds[label].length;
            total += count;
            const color = tagColorMap[label] || '#4fc3f7';
            html += `<div style="display:flex;justify-content:space-between;padding:2px 0">
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px"></span>${label}</span>
                <span>${count} 点</span>
            </div>`;
        }
        html = `<div style="margin-bottom:4px;color:#4fc3f7;font-weight:bold">共 ${total} 个种子点 / ${keys.length} 类</div>` + html;
        el.innerHTML = html;
        el.style.color = '#eee';
    },

    async runSegmentation() {
        const keys = Object.keys(this.semiAutoSeeds);
        if (keys.length === 0) {
            this.showToast('请先添加种子点', true);
            return;
        }
        const method = document.getElementById('segmentMethodSelect').value;
        this.showLoading('正在执行扩散算法...');
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/segment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    positions: this.pointData.positions,
                    normals: this.pointData.normals,
                    seed_points: this.semiAutoSeeds,
                    method: method
                })
            });
            if (!res.ok) throw new Error((await res.json()).detail || 'Segmentation failed');
            const data = await res.json();
            this.hideLoading();
            this.segmentPreview = data.predicted_labels;
            this.showSegmentPreview(data);
            this.updatePointColors();
            this.showToast(`扩散完成！共预测 ${data.total_predicted} 个点`);
        } catch (e) {
            this.hideLoading();
            this.showToast('扩散失败: ' + e.message, true);
        }
    },

    showSegmentPreview(data) {
        const panel = document.getElementById('previewPanel');
        const summary = document.getElementById('previewSummary');
        const tagColorMap = {};
        for (const tag of this.tags) {
            tagColorMap[tag.name] = tag.color;
        }
        let html = '';
        for (const [label, count] of Object.entries(data.per_label_counts)) {
            const seedsCount = (data.seed_points[label] || []).length;
            const color = tagColorMap[label] || '#4fc3f7';
            html += `<div style="display:flex;justify-content:space-between;padding:2px 0">
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px"></span>${label}</span>
                <span>+${count - seedsCount} (种子${seedsCount})</span>
            </div>`;
        }
        summary.innerHTML = html;
        panel.style.display = 'block';
    },

    async confirmSegmentation() {
        if (!this.segmentPreview) return;
        this.showLoading('正在应用标注...');
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/segment/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: this.me.user_id,
                    username: this.me.username,
                    user_color: this.me.color,
                    predictions: this.segmentPreview
                })
            });
            if (!res.ok) throw new Error('Apply failed');
            const data = await res.json();
            this.hideLoading();
            this.showToast(`成功应用 ${data.applied_count} 个新标注`);
            this.segmentPreview = null;
            this.semiAutoSeeds = {};
            document.getElementById('previewPanel').style.display = 'none';
            this.updateSeedSummary();
            this.updatePointColors();
        } catch (e) {
            this.hideLoading();
            this.showToast('应用失败: ' + e.message, true);
        }
    },

    cancelSegmentation() {
        this.segmentPreview = null;
        document.getElementById('previewPanel').style.display = 'none';
        this.updatePointColors();
    },

    async saveCurrentVersion() {
        const name = document.getElementById('versionNameInput').value.trim();
        this.showLoading('保存版本中...');
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/versions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: this.me.user_id,
                    username: this.me.username,
                    user_color: this.me.color,
                    name: name || undefined
                })
            });
            if (!res.ok) throw new Error('Save version failed');
            const data = await res.json();
            this.hideLoading();
            document.getElementById('versionNameInput').value = '';
            this.showToast(`版本「${data.version.name}」已保存`);
        } catch (e) {
            this.hideLoading();
            this.showToast('保存失败: ' + e.message, true);
        }
    },

    renderVersions() {
        const listEl = document.getElementById('versionList');
        if (!this.versions || this.versions.length === 0) {
            listEl.innerHTML = '<div style="color:#aaa">暂无保存版本</div>';
            return;
        }
        let html = '';
        for (const v of this.versions) {
            const date = new Date(v.created_at * 1000);
            const timeStr = `${date.getMonth()+1}-${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
            html += `<div style="padding:6px 4px;border-bottom:1px solid #0f3460;margin-bottom:4px">
                <div style="display:flex;align-items:center;margin-bottom:3px">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${v.created_by_color || '#4fc3f7'};margin-right:5px"></span>
                    <span style="font-weight:bold;font-size:12px">${v.name}</span>
                </div>
                <div style="font-size:11px;color:#aaa;margin-bottom:4px">
                    ${v.created_by_username} · ${timeStr}<br>
                    ${v.annotations_count} 个标注
                </div>
                <div style="display:flex;gap:3px">
                    <button onclick="App.restoreVersion('${v.version_id}')" style="padding:2px 6px;font-size:11px;background:#2ecc71;border-color:#2ecc71">回退</button>
                    <button onclick="App.deleteVersion('${v.version_id}')" style="padding:2px 6px;font-size:11px;background:#e74c3c;border-color:#e74c3c">删除</button>
                </div>
            </div>`;
        }
        listEl.innerHTML = html;
    },

    async restoreVersion(versionId) {
        if (!confirm('确定要回退到该版本吗？当前所有未保存的修改将丢失！')) return;
        this.showLoading('正在回退版本...');
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/versions/${encodeURIComponent(versionId)}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: this.me.user_id,
                    username: this.me.username
                })
            });
            if (!res.ok) throw new Error('Restore failed');
            const data = await res.json();
            this.hideLoading();
            this.showToast(`已回退到版本「${data.version_id}」`);
        } catch (e) {
            this.hideLoading();
            this.showToast('回退失败: ' + e.message, true);
        }
    },

    async deleteVersion(versionId) {
        if (!confirm('确定删除该版本吗？')) return;
        try {
            await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/versions/${encodeURIComponent(versionId)}`, {
                method: 'DELETE'
            });
            const idx = this.versions.findIndex(v => v.version_id === versionId);
            if (idx >= 0) {
                this.versions.splice(idx, 1);
            }
            this.renderVersions();
            this.showToast('版本已删除');
        } catch (e) {
            this.showToast('删除失败', true);
        }
    },

    updatePointColors() {
        if (!this.pointGeometry || !this.baseColors) return;
        const colors = this.baseColors.slice();
        for (const [idxStr, ann] of Object.entries(this.annotations)) {
            const idx = parseInt(idxStr);
            if (idx < colors.length / 3) {
                const c = new THREE.Color(ann.user_color);
                colors[idx * 3] = c.r;
                colors[idx * 3 + 1] = c.g;
                colors[idx * 3 + 2] = c.b;
            }
        }
        if (this.segmentPreview) {
            const tagColorMap = {};
            for (const tag of this.tags) {
                tagColorMap[tag.name] = new THREE.Color(tag.color);
            }
            for (const [label, pointIndices] of Object.entries(this.segmentPreview)) {
                const c = tagColorMap[label] || new THREE.Color(0x4fc3f7);
                for (const pointIdx of pointIndices) {
                    if (pointIdx < colors.length / 3 && !(pointIdx in this.annotations)) {
                        colors[pointIdx * 3] = c.r * 0.6;
                        colors[pointIdx * 3 + 1] = c.g * 0.6;
                        colors[pointIdx * 3 + 2] = c.b * 0.6;
                    }
                }
            }
        }
        for (const [label, seedIndices] of Object.entries(this.semiAutoSeeds)) {
            const tagColorMap = {};
            for (const tag of this.tags) {
                tagColorMap[tag.name] = new THREE.Color(tag.color);
            }
            const c = tagColorMap[label] || new THREE.Color(0xffff00);
            for (const seedIdx of seedIndices) {
                if (seedIdx < colors.length / 3) {
                    colors[seedIdx * 3] = Math.min(1, c.r * 1.4);
                    colors[seedIdx * 3 + 1] = Math.min(1, c.g * 1.4);
                    colors[seedIdx * 3 + 2] = Math.min(1, c.b * 1.4);
                }
            }
        }
        for (const [lockIdxStr, lock] of Object.entries(this.locks)) {
            if (lock.user_id === this.me.user_id) continue;
            for (const pointIdx of lock.locked_points) {
                if (pointIdx < colors.length / 3) {
                    colors[pointIdx * 3] = 1.0;
                    colors[pointIdx * 3 + 1] = 0.2;
                    colors[pointIdx * 3 + 2] = 0.2;
                }
            }
        }
        const highlightColor = new THREE.Color(0xffffff);
        for (const idx of this.selectedPoints) {
            if (idx < colors.length / 3) {
                colors[idx * 3] = highlightColor.r;
                colors[idx * 3 + 1] = highlightColor.g;
                colors[idx * 3 + 2] = highlightColor.b;
            }
        }
        this.pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        this.pointGeometry.attributes.color.needsUpdate = true;
    },

    bindUI() {
        document.getElementById('uploadBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        document.getElementById('fileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.uploadModel(file);
        });

        document.getElementById('voxelizeBtn').addEventListener('click', () => {
            this.voxelizeModel();
        });

        document.getElementById('modePoint').addEventListener('click', () => {
            this.setMode('point');
        });

        document.getElementById('modeBox').addEventListener('click', () => {
            this.setMode('box');
        });

        document.getElementById('modeSemiAuto').addEventListener('click', () => {
            this.setMode('semiauto');
        });

        document.getElementById('runSegmentBtn').addEventListener('click', () => {
            this.runSegmentation();
        });

        document.getElementById('clearSeedsBtn').addEventListener('click', () => {
            this.clearSemiAutoSeeds();
        });

        document.getElementById('confirmSegmentBtn').addEventListener('click', () => {
            this.confirmSegmentation();
        });

        document.getElementById('cancelSegmentBtn').addEventListener('click', () => {
            this.cancelSegmentation();
        });

        document.getElementById('saveVersionBtn').addEventListener('click', () => {
            this.saveCurrentVersion();
        });

        document.getElementById('addTagBtn').addEventListener('click', () => {
            const input = document.getElementById('newTagInput');
            const name = input.value.trim();
            if (name) {
                this.addTag(name, this.randomColor());
                input.value = '';
            }
        });

        document.getElementById('saveUserBtn').addEventListener('click', () => {
            this.saveUserInfo();
        });

        document.getElementById('releaseLockBtn').addEventListener('click', () => {
            if (this.myLock) {
                this.releaseLock(this.myLock.point_index);
                this.showToast('锁已释放');
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.selectedPoints.size > 0) {
                this.annotateSelectedPoints();
            } else if (e.key === 'Escape') {
                if (this.myLock) {
                    this.releaseLock(this.myLock.point_index);
                }
                this.selectedPoints.clear();
                this.updatePointColors();
            } else if (e.key === 'Delete' && this.hoveredPoint !== null) {
                this.removeAnnotation(this.hoveredPoint);
            }
        });
    },

    async loadModels() {
        try {
            const res = await fetch(`${API_BASE}/api/models`);
            const data = await res.json();
            const select = document.getElementById('modelSelect');
            select.innerHTML = '';
            data.models.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            });
            if (data.models.length > 0) {
                select.value = data.models[0];
                this.modelName = data.models[0];
                this.loadPointCloud();
            }
        } catch (e) {
            console.error('Load models failed:', e);
        }
    },

    async uploadModel(file) {
        this.showLoading('上传模型中...');
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`${API_BASE}/api/models/upload`, {
                method: 'POST',
                body: formData
            });
            if (!res.ok) throw new Error('Upload failed');
            this.hideLoading();
            this.showToast('模型上传成功');
            this.loadModels();
        } catch (e) {
            this.hideLoading();
            this.showToast('上传失败: ' + e.message, true);
        }
    },

    async voxelizeModel() {
        const modelName = document.getElementById('modelSelect').value;
        const resolution = parseInt(document.getElementById('resolutionSelect').value);
        if (!modelName) return;
        this.showLoading('体素化中，请稍候...');
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(modelName)}/voxelize?resolution=${resolution}`);
            if (!res.ok) throw new Error((await res.json()).detail || 'Voxelize failed');
            const data = await res.json();
            this.hideLoading();
            this.showToast(`体素化完成，共 ${data.num_points} 个点`);
            this.modelName = modelName;
            this.loadPointCloud();
        } catch (e) {
            this.hideLoading();
            this.showToast('体素化失败: ' + e.message, true);
        }
    },

    async loadPointCloud() {
        const modelName = document.getElementById('modelSelect').value;
        const resolution = parseInt(document.getElementById('resolutionSelect').value);
        if (!modelName) return;
        this.modelName = modelName;
        this.showLoading('加载点云...');
        this.annotations = {};
        this.locks = {};
        this.myLock = null;
        this.versions = [];
        this.semiAutoSeeds = {};
        this.segmentPreview = null;
        this.selectedPoints.clear();
        if (this.lockCheckInterval) {
            clearInterval(this.lockCheckInterval);
            this.lockCheckInterval = null;
        }
        document.getElementById('previewPanel').style.display = 'none';
        document.getElementById('semiAutoPanel').style.display = this.mode === 'semiauto' ? 'block' : 'none';
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(modelName)}/pointcloud?resolution=${resolution}`);
            if (!res.ok) throw new Error('Failed to load pointcloud');
            const data = await res.json();
            this.hideLoading();
            this.renderPointCloud(data);
            this.loadTags();
            this.loadUsers();
            this.loadVersions();
            this.connectWebSocket();
            this.updateSeedSummary();
        } catch (e) {
            this.hideLoading();
            this.showToast('加载失败: ' + e.message, true);
        }
    },

    async loadVersions() {
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/versions`);
            const data = await res.json();
            this.versions = data.versions || [];
            this.renderVersions();
        } catch (e) {
            console.error('Load versions failed:', e);
        }
    },

    renderPointCloud(data) {
        this.pointData = data;
        if (this.pointCloud) {
            this.scene.remove(this.pointCloud);
            this.pointCloud.geometry.dispose();
            this.pointCloud.material.dispose();
            this.pointCloud = null;
        }
        this.clearLockMeshes();
        const positions = data.positions;
        const normals = data.normals;
        const count = positions.length;
        const posArr = new Float32Array(count * 3);
        const normArr = new Float32Array(count * 3);
        const colorArr = new Float32Array(count * 3);
        const defaultColor = new THREE.Color(0x4fc3f7);
        for (let i = 0; i < count; i++) {
            posArr[i * 3] = positions[i][0];
            posArr[i * 3 + 1] = positions[i][1];
            posArr[i * 3 + 2] = positions[i][2];
            if (normals && normals[i]) {
                normArr[i * 3] = normals[i][0];
                normArr[i * 3 + 1] = normals[i][1];
                normArr[i * 3 + 2] = normals[i][2];
            } else {
                normArr[i * 3 + 2] = 1;
            }
            colorArr[i * 3] = defaultColor.r;
            colorArr[i * 3 + 1] = defaultColor.g;
            colorArr[i * 3 + 2] = defaultColor.b;
        }
        this.baseColors = Array.from(colorArr);
        this.pointGeometry = new THREE.BufferGeometry();
        this.pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
        this.pointGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
        this.pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colorArr, 3));
        const pointSize = Math.max(0.005, 2 / Math.sqrt(count));
        this.pointMaterial = new THREE.PointsMaterial({
            size: pointSize,
            vertexColors: true,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.9
        });
        this.pointCloud = new THREE.Points(this.pointGeometry, this.pointMaterial);
        this.scene.add(this.pointCloud);
        const bounds = data.bounds;
        const center = new THREE.Vector3(
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2
        );
        const size = new THREE.Vector3(
            bounds.max[0] - bounds.min[0],
            bounds.max[1] - bounds.min[1],
            bounds.max[2] - bounds.min[2]
        );
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 2;
        this.camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.7, distance));
        this.controls.target.copy(center);
        this.controls.update();
        this.startLockCheck();
    },

    renderLockRegion(lock) {
        const radiusM = lock.radius / 100.0;
        const geometry = new THREE.SphereGeometry(radiusM, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: lock.user_id === this.me.user_id ? 0x4fc3f7 : 0xff3333,
            transparent: true,
            opacity: 0.15,
            wireframe: false
        });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(lock.center_point[0], lock.center_point[1], lock.center_point[2]);
        sphere.userData.isLockMesh = true;
        sphere.userData.lockId = lock.lock_id;

        const wireGeometry = new THREE.SphereGeometry(radiusM * 1.02, 16, 16);
        const wireMaterial = new THREE.MeshBasicMaterial({
            color: lock.user_id === this.me.user_id ? 0x4fc3f7 : 0xff3333,
            transparent: true,
            opacity: 0.4,
            wireframe: true
        });
        const wireSphere = new THREE.Mesh(wireGeometry, wireMaterial);
        wireSphere.position.copy(sphere.position);
        wireSphere.userData.isLockMesh = true;
        wireSphere.userData.lockId = lock.lock_id;

        this.scene.add(sphere);
        this.scene.add(wireSphere);
        this.lockMeshes.push(sphere, wireSphere);

        if (lock.user_id !== this.me.user_id) {
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'rgba(255, 51, 51, 0.9)';
            ctx.roundRect(0, 0, 256, 64, 8);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 20px Microsoft YaHei';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${lock.username} 正在标注这里`, 128, 32);
            const texture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthTest: false
            });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.position.set(lock.center_point[0], lock.center_point[1] + radiusM + 0.05, lock.center_point[2]);
            sprite.scale.set(0.4, 0.1, 1);
            sprite.userData.isLockMesh = true;
            sprite.userData.lockId = lock.lock_id;
            this.scene.add(sprite);
            this.lockMeshes.push(sprite);
        }
    },

    clearLockMeshes() {
        for (const mesh of this.lockMeshes) {
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
                if (mesh.material.map) mesh.material.map.dispose();
                mesh.material.dispose();
            }
        }
        this.lockMeshes = [];
    },

    renderAllLocks() {
        this.clearLockMeshes();
        for (const lock of Object.values(this.locks)) {
            this.renderLockRegion(lock);
        }
        this.updateLockStatus();
    },

    addLock(lock) {
        this.locks[lock.point_index] = lock;
        if (lock.user_id === this.me.user_id) {
            this.myLock = lock;
        }
        this.renderLockRegion(lock);
        this.updatePointColors();
        this.updateLockStatus();
    },

    removeLock(pointIndex) {
        const lock = this.locks[pointIndex];
        if (lock) {
            if (lock.user_id === this.me.user_id) {
                this.myLock = null;
            }
            delete this.locks[pointIndex];
        }
        this.lockMeshes = this.lockMeshes.filter(mesh => {
            if (mesh.userData?.lockId === lock?.lock_id) {
                this.scene.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    if (mesh.material.map) mesh.material.map.dispose();
                    mesh.material.dispose();
                }
                return false;
            }
            return true;
        });
        this.updatePointColors();
        this.updateLockStatus();
    },

    updateLockStatus() {
        const releaseBtn = document.getElementById('releaseLockBtn');
        const lockInfo = document.getElementById('lockInfo');
        const noLockInfo = document.getElementById('noLockInfo');
        const lockOwner = document.getElementById('lockOwner');
        const lockPointCount = document.getElementById('lockPointCount');

        const hasLocks = Object.keys(this.locks).length > 0;
        if (hasLocks) {
            const firstLock = Object.values(this.locks)[0];
            lockInfo.style.display = 'block';
            noLockInfo.style.display = 'none';
            const lockUser = firstLock.user_id === this.me.user_id ? '我' : firstLock.username;
            lockOwner.textContent = lockUser;
            lockOwner.style.color = firstLock.user_color;
            let totalPoints = 0;
            for (const l of Object.values(this.locks)) {
                totalPoints += l.locked_points.length;
            }
            lockPointCount.textContent = totalPoints;
        } else {
            lockInfo.style.display = 'none';
            noLockInfo.style.display = 'block';
        }

        if (this.myLock) {
            releaseBtn.style.display = 'inline-block';
        } else {
            releaseBtn.style.display = 'none';
        }
    },

    startLockCheck() {
        if (this.lockCheckInterval) {
            clearInterval(this.lockCheckInterval);
        }
        this.lockCheckInterval = setInterval(() => {
            const now = Date.now() / 1000;
            let changed = false;
            for (const [pointIdx, lock] of Object.entries(this.locks)) {
                if (lock.expires_at < now) {
                    delete this.locks[pointIdx];
                    if (lock.user_id === this.me.user_id) {
                        this.myLock = null;
                    }
                    changed = true;
                }
            }
            if (changed) {
                this.renderAllLocks();
                this.updatePointColors();
            }
        }, 1000);
    },

    async acquireLock(pointIndex) {
        if (!this.pointData || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return { success: false, message: '未连接到服务器' };
        }
        for (const lock of Object.values(this.locks)) {
            if (lock.user_id !== this.me.user_id && lock.locked_points.includes(pointIndex)) {
                return {
                    success: false,
                    message: `${lock.username} 正在标注这里，请稍候...`,
                    existing_lock: lock
                };
            }
        }
        const centerPoint = this.pointData.positions[pointIndex];
        return new Promise((resolve) => {
            this._lockAckCallback = (result) => {
                this._lockAckCallback = null;
                resolve(result);
            };
            this.ws.send(JSON.stringify({
                type: 'lock_acquire',
                point_index: pointIndex,
                center_point: centerPoint,
                positions: this.pointData.positions,
                radius: 1.0,
                ttl: 5
            }));
            setTimeout(() => {
                if (this._lockAckCallback) {
                    this._lockAckCallback = null;
                    resolve({ success: false, message: '申请锁超时' });
                }
            }, 6000);
        });
    },

    releaseLock(pointIndex) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'lock_release',
                point_index: pointIndex
            }));
        }
        this.removeLock(pointIndex);
    },

    async loadTags() {
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/tags`);
            const data = await res.json();
            this.tags = data.tags;
            this.renderTags();
        } catch (e) {
            console.error('Load tags failed:', e);
        }
    },

    renderTags() {
        const list = document.getElementById('tagList');
        const select = document.getElementById('currentTagSelect');
        list.innerHTML = '';
        select.innerHTML = '';
        this.tags.forEach(tag => {
            const div = document.createElement('div');
            div.className = 'tag-item' + (this.selectedTag === tag.name ? ' selected' : '');
            div.innerHTML = `
                <span class="tag-color" style="background:${tag.color}"></span>
                <span>${tag.name}</span>
                <span class="tag-count" id="tag-count-${tag.name}">0</span>
                <span class="tag-delete" data-name="${tag.name}">✕</span>
            `;
            div.addEventListener('click', (e) => {
                if (e.target.classList.contains('tag-delete')) return;
                this.selectedTag = tag.name;
                this.renderTags();
            });
            div.querySelector('.tag-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteTag(tag.name);
            });
            list.appendChild(div);
            const opt = document.createElement('option');
            opt.value = tag.name;
            opt.textContent = tag.name;
            if (this.selectedTag === tag.name) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', (e) => {
            this.selectedTag = e.target.value;
            this.renderTags();
        });
        if (this.selectedTag && this.tags.length > 0 && !this.tags.find(t => t.name === this.selectedTag)) {
            this.selectedTag = this.tags[0].name;
            this.renderTags();
        }
    },

    async addTag(name, color) {
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });
            const data = await res.json();
            this.tags = data.tags;
            this.renderTags();
            this.showToast('标签已添加');
        } catch (e) {
            this.showToast('添加失败', true);
        }
    },

    async deleteTag(name) {
        try {
            await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/tags/${encodeURIComponent(name)}`, {
                method: 'DELETE'
            });
            if (this.selectedTag === name) this.selectedTag = null;
            this.showToast('标签已删除');
        } catch (e) {
            this.showToast('删除失败', true);
        }
    },

    async loadUsers() {
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(this.modelName)}/users`);
            const data = await res.json();
            this.users = data.users;
            this.renderUsers();
            this.updateStats();
        } catch (e) {
            console.error('Load users failed:', e);
        }
    },

    renderUsers() {
        const list = document.getElementById('userList');
        list.innerHTML = '';
        this.users.forEach(user => {
            const div = document.createElement('div');
            const isMe = user.user_id === this.me.user_id;
            div.className = 'user-item' + (isMe ? ' me' : '');
            div.innerHTML = `
                <span class="user-color" style="background:${user.color}"></span>
                <span>${user.username}${isMe ? ' (我)' : ''}</span>
            `;
            list.appendChild(div);
        });
    },

    saveUserInfo() {
        this.me.username = document.getElementById('usernameInput').value || this.me.username;
        this.me.color = document.getElementById('userColorInput').value;
        localStorage.setItem('username', this.me.username);
        localStorage.setItem('user_color', this.me.color);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'update_user',
                username: this.me.username,
                color: this.me.color
            }));
        }
        this.showToast('用户信息已保存');
    },

    connectWebSocket() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }
        const wsUrl = `${WS_BASE}/ws/${encodeURIComponent(this.modelName)}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                type: 'join',
                user_id: this.me.user_id,
                username: this.me.username,
                color: this.me.color
            }));
            this.showToast('已连接协作服务器');
            this.startHeartbeat();
        };
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            this.handleWSMessage(msg);
        };
        this.ws.onclose = () => {
            this.showToast('WebSocket 断开，正在重连...', true);
            clearInterval(this._heartbeat);
            this.locks = {};
            this.myLock = null;
            this.clearLockMeshes();
            setTimeout(() => this.connectWebSocket(), 3000);
        };
        this.ws.onerror = () => {};
    },

    startHeartbeat() {
        clearInterval(this._heartbeat);
        this._heartbeat = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    },

    handleWSMessage(msg) {
        switch (msg.type) {
            case 'welcome':
                this.me.user_id = msg.user_id;
                break;
            case 'users_updated':
                this.users = msg.users;
                this.renderUsers();
                break;
            case 'tags_updated':
                this.tags = msg.tags;
                this.renderTags();
                break;
            case 'annotations_init':
                this.annotations = {};
                msg.annotations.forEach(a => {
                    this.annotations[a.point_index] = a;
                });
                this.updatePointColors();
                this.updateStats();
                break;
            case 'annotations_added':
                msg.annotations.forEach(a => {
                    this.annotations[a.point_index] = a;
                });
                this.updatePointColors();
                this.updateStats();
                if (msg.by_user !== this.me.user_id) {
                    this.showToast(`${msg.annotations[0]?.username || '其他用户'} 标注了 ${msg.annotations.length} 个点`);
                }
                break;
            case 'annotation_removed':
                delete this.annotations[msg.point_index];
                this.updatePointColors();
                this.updateStats();
                break;
            case 'user_updated':
                this.me = msg.user;
                document.getElementById('usernameInput').value = this.me.username;
                document.getElementById('userColorInput').value = this.me.color;
                break;
            case 'locks_init':
                this.locks = {};
                msg.locks.forEach(lock => {
                    this.locks[lock.point_index] = lock;
                    if (lock.user_id === this.me.user_id) {
                        this.myLock = lock;
                    }
                });
                this.renderAllLocks();
                this.updatePointColors();
                break;
            case 'lock_acquired':
                this.addLock(msg.lock);
                if (msg.by_user !== this.me.user_id) {
                    this.showToast(`${msg.lock.username} 开始标注一个区域`, true);
                }
                break;
            case 'lock_acquired_ack':
                if (this._lockAckCallback) {
                    this._lockAckCallback({
                        success: msg.success,
                        lock: msg.lock,
                        existing_lock: msg.existing_lock,
                        message: msg.message
                    });
                }
                break;
            case 'lock_released':
                this.removeLock(msg.point_index);
                break;
            case 'versions_init':
                this.versions = msg.versions || [];
                this.renderVersions();
                break;
            case 'version_saved':
                if (msg.version) {
                    this.versions.unshift(msg.version);
                    this.renderVersions();
                }
                if (msg.version && msg.version.created_by === this.me.user_id) {
                    this.showToast(`版本「${msg.version.name}」已保存`);
                } else if (msg.version) {
                    this.showToast(`${msg.version.created_by_username} 保存了版本「${msg.version.name}」`);
                }
                break;
            case 'version_restored':
                this.annotations = {};
                if (msg.annotations) {
                    msg.annotations.forEach(a => {
                        this.annotations[a.point_index] = a;
                    });
                }
                if (msg.tags) {
                    this.tags = msg.tags;
                    this.renderTags();
                }
                this.updatePointColors();
                this.updateStats();
                if (msg.restored_by && msg.restored_by.user_id !== this.me.user_id) {
                    this.showToast(`${msg.restored_by.username} 回退到版本「${msg.version_name}」`, true);
                }
                break;
        }
    },

    async annotateSelectedPoints() {
        if (this.selectedPoints.size === 0) {
            this.showToast('请先选择点', true);
            return;
        }
        if (!this.selectedTag && this.tags.length > 0) {
            this.selectedTag = this.tags[0].name;
            this.renderTags();
        }
        if (!this.selectedTag) {
            this.showToast('请先添加并选择一个标签', true);
            return;
        }
        if (this.myLock) {
            this.releaseLock(this.myLock.point_index);
        }
        const firstPoint = Array.from(this.selectedPoints)[0];
        const lockResult = await this.acquireLock(firstPoint);
        if (!lockResult.success) {
            this.showToast(lockResult.message || '无法获取标注区域锁', true);
            return;
        }
        const lock = lockResult.lock;
        const overlapping = [];
        for (const p of this.selectedPoints) {
            if (!lock.locked_points.includes(p)) {
                overlapping.push(p);
            }
        }
        if (overlapping.length > 0 && overlapping.length !== this.selectedPoints.size) {
            const proceed = confirm(`选中的 ${overlapping.length} 个点超出锁定区域（半径1cm），是否仅对锁定区域内的 ${lock.locked_points.length} 个点进行标注？`);
            if (!proceed) {
                this.releaseLock(lock.point_index);
                return;
            }
        }
        const pointsToAnnotate = lock.locked_points.filter(p => this.selectedPoints.has(p));
        if (pointsToAnnotate.length === 0) {
            this.showToast('选中的点不在锁定区域内', true);
            this.releaseLock(lock.point_index);
            return;
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'annotate',
                point_indices: pointsToAnnotate,
                label: this.selectedTag,
                lock_point_index: lock.point_index
            }));
            this.showToast(`已提交 ${pointsToAnnotate.length} 个点的标注`);
            this.selectedPoints.clear();
            this.updatePointColors();
        } else {
            this.showToast('未连接到服务器', true);
            this.releaseLock(lock.point_index);
        }
    },

    removeAnnotation(pointIndex) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'remove_annotation',
                point_index: pointIndex
            }));
            this.showToast('已删除标注');
        }
    },

    updateStats() {
        const tagCounts = {};
        for (const ann of Object.values(this.annotations)) {
            tagCounts[ann.label] = (tagCounts[ann.label] || 0) + 1;
        }
        Object.keys(tagCounts).forEach(tag => {
            const el = document.getElementById(`tag-count-${tag}`);
            if (el) el.textContent = tagCounts[tag];
        });
        const total = this.pointData?.num_points || 0;
        const annotated = Object.keys(this.annotations).length;
        const rate = total ? ((annotated / total) * 100).toFixed(2) : 0;
        const statsDiv = document.getElementById('stats');
        statsDiv.innerHTML = `
            <div class="stat-row"><span>总点数</span><span>${total}</span></div>
            <div class="stat-row"><span>已标注</span><span>${annotated}</span></div>
            <div class="stat-row"><span>未标注</span><span>${Math.max(0, total - annotated)}</span></div>
            <div class="stat-row"><span>标注率</span><span>${rate}%</span></div>
            <div class="stat-row"><span>在线用户</span><span>${this.users.length}</span></div>
        `;
    },

    showLoading(text = '加载中...') {
        document.getElementById('loadingText').textContent = text;
        document.getElementById('loading').classList.remove('hidden');
    },

    hideLoading() {
        document.getElementById('loading').classList.add('hidden');
    },

    showToast(text, isError = false) {
        const el = document.getElementById('toast');
        el.textContent = text;
        el.style.background = isError ? 'rgba(244,67,54,0.95)' : 'rgba(79,195,247,0.95)';
        el.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
    },

    onResize() {
        const container = document.getElementById('viewer');
        const rect = container.getBoundingClientRect();
        this.camera.aspect = rect.width / rect.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(rect.width, rect.height);
    },

    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    },

    genId() {
        return 'u_' + Math.random().toString(36).substr(2, 9);
    },

    randomColor() {
        const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#ff6b81', '#26de81'];
        return colors[Math.floor(Math.random() * colors.length)];
    }
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
