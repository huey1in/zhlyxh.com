const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;
const DATA_PATH = path.join(__dirname, 'data', 'timeline.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function loadTimelineData() {
    try {
        const raw = fs.readFileSync(DATA_PATH, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        const items = parsed.items || [];
        let changed = false;
        const baseTime = Date.now();
        parsed.items = items.map((item, index) => {
            if (!item.id) {
                changed = true;
                return { ...item, id: `item-${index}-${baseTime}` };
            }
            return item;
        });
        if (changed) {
            saveTimelineData(parsed);
        }
        return parsed;
    } catch (err) {
        console.error('Failed to load timeline data:', err);
        return { startDate: '2022-12-25', items: [] };
    }
}

function saveTimelineData(data) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const parsed = body ? JSON.parse(body) : {};
                resolve(parsed);
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function serveFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Server Error');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

function ensureUploadDir() {
    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
}

// 清理未被引用的上传文件
function cleanupUnusedUploads() {
    ensureUploadDir();
    try {
        const data = loadTimelineData();
        // 收集所有被引用的图片路径
        const usedImages = new Set();
        (data.items || []).forEach(item => {
            // 支持新的 images 数组格式
            if (item.images && Array.isArray(item.images)) {
                item.images.forEach(img => usedImages.add(img));
            }
            // 兼容旧的 image 字段
            if (item.image) {
                usedImages.add(item.image);
            }
        });

        // 遍历上传目录，删除未被引用的文件
        const files = fs.readdirSync(UPLOAD_DIR);
        let deletedCount = 0;
        files.forEach(filename => {
            const filePath = path.join(UPLOAD_DIR, filename);
            if (fs.statSync(filePath).isDirectory()) return;
            
            const uploadPath = `/uploads/${filename}`;
            if (!usedImages.has(uploadPath)) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`已清理未使用的文件: ${filename}`);
            }
        });
        
        return deletedCount;
    } catch (err) {
        console.error('清理上传文件失败:', err);
        return 0;
    }
}

function tryServeStatic(baseDir, relativePath, res) {
    const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const absolutePath = path.join(baseDir, safePath);
    if (!absolutePath.startsWith(baseDir)) return false;
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        serveFile(res, absolutePath);
        return true;
    }
    return false;
}

const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    if (req.method === 'GET' && urlPath.startsWith('/api/items')) {
        const data = loadTimelineData();
        return sendJson(res, 200, data);
    }

    if (req.method === 'POST' && urlPath === '/api/items') {
        try {
            const body = await parseBody(req);
            if (!body.title || !body.date) {
                return sendJson(res, 400, { error: 'title, date are required' });
            }
            const data = loadTimelineData();
            // 限制最多9张图片
            let images = body.images || [];
            if (images.length > 9) {
                images = images.slice(0, 9);
            }
            const newItem = {
                id: `item-${Date.now()}`,
                date: body.date,
                title: body.title,
                images: images,
                views: {
                    zhl: body.views?.zhl || '',
                    yxh: body.views?.yxh || ''
                }
            };
            data.items.push(newItem);
            saveTimelineData(data);
            return sendJson(res, 201, newItem);
        } catch (err) {
            return sendJson(res, 400, { error: 'Invalid JSON body' });
        }
    }

    if ((req.method === 'PUT' || req.method === 'DELETE') && urlPath.startsWith('/api/items/')) {
        const id = urlPath.replace('/api/items/', '');
        const data = loadTimelineData();
        const index = data.items.findIndex((item) => item.id === id);
        if (index === -1) {
            return sendJson(res, 404, { error: 'Item not found' });
        }

        if (req.method === 'DELETE') {
            const removed = data.items.splice(index, 1)[0];
            saveTimelineData(data);
            return sendJson(res, 200, removed);
        }

        try {
            const body = await parseBody(req);
            const existingItem = data.items[index];
            // 限制最多9张图片
            let images = body.images !== undefined ? body.images : (existingItem.images || []);
            if (images.length > 9) {
                images = images.slice(0, 9);
            }
            data.items[index] = {
                ...existingItem,
                date: body.date || existingItem.date,
                title: body.title || existingItem.title,
                images: images,
                views: {
                    zhl: body.views?.zhl !== undefined ? body.views.zhl : (existingItem.views?.zhl || ''),
                    yxh: body.views?.yxh !== undefined ? body.views.yxh : (existingItem.views?.yxh || '')
                }
            };
            saveTimelineData(data);
            return sendJson(res, 200, data.items[index]);
        } catch (err) {
            return sendJson(res, 400, { error: 'Invalid JSON body' });
        }
    }

    if (req.method === 'PUT' && urlPath === '/api/startDate') {
        try {
            const body = await parseBody(req);
            if (!body.startDate) {
                return sendJson(res, 400, { error: 'startDate is required' });
            }
            const data = loadTimelineData();
            data.startDate = body.startDate;
            saveTimelineData(data);
            return sendJson(res, 200, { startDate: data.startDate });
        } catch (err) {
            return sendJson(res, 400, { error: 'Invalid JSON body' });
        }
    }

    if (req.method === 'GET' && urlPath === '/admin') {
        const adminIndex = path.join(ADMIN_DIR, 'index.html');
        return serveFile(res, adminIndex);
    }
    if (req.method === 'GET' && urlPath.startsWith('/admin/')) {
        const rel = urlPath.replace('/admin/', '');
        if (tryServeStatic(ADMIN_DIR, rel, res)) return;
    }
    if (req.method === 'GET' && (urlPath === '/gallery' || urlPath === '/gallery/')) {
        const galleryPath = path.join(PUBLIC_DIR, 'gallery.html');
        if (fs.existsSync(galleryPath)) return serveFile(res, galleryPath);
    }

    if (req.method === 'POST' && urlPath === '/api/upload') {
        try {
            const body = await parseBody(req);
            if (!body.filename || !body.dataUrl) {
                return sendJson(res, 400, { error: 'filename and dataUrl are required' });
            }
            const match = body.dataUrl.match(/^data:(.+);base64,(.+)$/);
            if (!match) {
                return sendJson(res, 400, { error: 'Invalid dataUrl' });
            }
            ensureUploadDir();
            const ext = path.extname(body.filename) || '.png';
            const safeName = `upload-${Date.now()}${ext}`;
            const filePath = path.join(UPLOAD_DIR, safeName);
            fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
            return sendJson(res, 201, { url: `/uploads/${safeName}` });
        } catch (err) {
            console.error('Upload error', err);
            return sendJson(res, 500, { error: 'Upload failed' });
        }
    }

    if (req.method === 'GET' && urlPath === '/api/uploads') {
        ensureUploadDir();
        try {
            // 调用相册接口时自动清理未使用的文件
            const deletedCount = cleanupUnusedUploads();
            if (deletedCount > 0) {
                console.log(`本次清理了 ${deletedCount} 个未使用的文件`);
            }
            
            const files = fs.readdirSync(UPLOAD_DIR)
                .filter((name) => !fs.statSync(path.join(UPLOAD_DIR, name)).isDirectory())
                .map((name) => `/uploads/${name}`);
            return sendJson(res, 200, { files, cleaned: deletedCount });
        } catch (err) {
            console.error('List uploads error', err);
            return sendJson(res, 500, { error: 'List uploads failed' });
        }
    }

    const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^[/\\]/, '');
    if (tryServeStatic(PUBLIC_DIR, relPath, res)) return;
    if (urlPath.startsWith('/uploads/')) {
        const rel = urlPath.replace('/uploads/', '');
        if (tryServeStatic(UPLOAD_DIR, rel, res)) return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
