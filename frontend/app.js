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

    pickPoint(e, replace = false) {
        if (!this.pointCloud) return;
        this.raycaster.setFromCamera(this.mouseNormalized, this.camera);
        const intersects = this.raycaster.intersectObject(this.pointCloud);
        if (intersects.length > 0) {
            const idx = intersects[0].index;
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

        const v = new THREE.Vector3();
        for (let i = 0; i < positions.length; i++) {
            v.set(positions[i][0], positions[i][1], positions[i][2]);
            v.project(this.camera);
            if (v.x >= minX && v.x <= maxX && v.y >= minY && v.y <= maxY) {
                this.selectedPoints.add(i);
            }
        }
        this.showToast(`已选择 ${this.selectedPoints.size} 个点`);
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
            this.mode = 'point';
            document.getElementById('modePoint').classList.add('active');
            document.getElementById('modeBox').classList.remove('active');
        });

        document.getElementById('modeBox').addEventListener('click', () => {
            this.mode = 'box';
            document.getElementById('modeBox').classList.add('active');
            document.getElementById('modePoint').classList.remove('active');
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

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.selectedPoints.size > 0) {
                this.annotateSelectedPoints();
            } else if (e.key === 'Escape') {
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
        this.selectedPoints.clear();
        try {
            const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(modelName)}/pointcloud?resolution=${resolution}`);
            if (!res.ok) throw new Error('Failed to load pointcloud');
            const data = await res.json();
            this.hideLoading();
            this.renderPointCloud(data);
            this.loadTags();
            this.loadUsers();
            this.connectWebSocket();
        } catch (e) {
            this.hideLoading();
            this.showToast('加载失败: ' + e.message, true);
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
        }
    },

    annotateSelectedPoints() {
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'annotate',
                point_indices: Array.from(this.selectedPoints),
                label: this.selectedTag
            }));
            this.showToast(`已提交 ${this.selectedPoints.size} 个点的标注`);
            this.selectedPoints.clear();
            this.updatePointColors();
        } else {
            this.showToast('未连接到服务器', true);
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
