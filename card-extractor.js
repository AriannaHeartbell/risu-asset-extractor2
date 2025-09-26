// --- DOM 요소 가져오기 ---
const dropZone = document.getElementById('cardDropZone');
const fileInput = document.getElementById('cardFileInput');
const statusDiv = document.getElementById('cardStatus');
const downloadAllBtn = document.getElementById('cardDownloadAllBtn');

let finalZip = null; // 추출된 파일을 담을 JSZip 인스턴스

// --- 이벤트 리스너 설정 ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});
downloadAllBtn.addEventListener('click', downloadZip);

// --- 헬퍼 함수 ---
function updateStatus(message, type = '') {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
}

function detectImageExtension(data) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return '.png';
    if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return '.jpg';
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return '.webp';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return '.gif';
    return '.dat';
}

// --- 메인 파일 처리 로직 ---
async function handleFile(file) {
    updateStatus(`'${file.name}' 처리 중...`);
    downloadAllBtn.style.display = 'none';
    finalZip = new JSZip();

    try {
        if (file.name.toLowerCase().endsWith('.charx')) {
            await handleCharx(file);
        } else if (file.name.toLowerCase().endsWith('.png')) {
            await handlePng(file);
        } else {
            throw new Error("지원하지 않는 파일 형식입니다. '.png' 또는 '.charx' 파일을 선택해주세요.");
        }
        updateStatus(`추출 완료! 총 ${Object.keys(finalZip.files).length}개의 파일을 찾았습니다.`, 'success');
        if (Object.keys(finalZip.files).length > 0) {
            downloadAllBtn.style.display = 'block';
        }
    } catch (error) {
        updateStatus(`오류 발생: ${error.message}`, 'error');
        console.error(error);
    }
}

// --- .charx (ZIP) 파일 처리 ---
async function handleCharx(file) {
    const zip = await JSZip.loadAsync(file);
    const cardJsonFile = zip.file('card.json');
    if (!cardJsonFile) {
        throw new Error("'card.json'을 찾을 수 없습니다.");
    }

    const charData = JSON.parse(await cardJsonFile.async('string'));
    const assetsInfo = charData?.data?.assets || [];

    if (assetsInfo.length === 0) {
        updateStatus("경고: 'card.json'에서 에셋 정보를 찾지 못했습니다.", "warning");
        return;
    }

    const promises = assetsInfo.map(async (assetInfo) => {
        const { uri, name, ext } = assetInfo;
        if (!uri || !name) return;

        const sourcePath = uri.replace(/embeded?:\/\//, '');
        const sourceFile = zip.file(sourcePath);

        if (sourceFile) {
            const data = await sourceFile.async('uint8array');
            let finalName = name;
            if (ext && !name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
                finalName = `${name}.${ext}`;
            }
            finalZip.file(finalName, data);
        }
    });

    await Promise.all(promises);
}

// --- .png 카드 파일 처리 ---
async function handlePng(file) {
    const buffer = await file.arrayBuffer();
    const chunks = extract(new Uint8Array(buffer));
    const textChunks = chunks.filter(chunk => chunk.name === 'tEXt');
    
    let mainDataStr = null;
    const assets = {};

    textChunks.forEach(chunk => {
        const [key, value] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(chunk.data).split('\x00');
        if (key.startsWith('chara-ext-asset_')) {
            const assetIndex = parseInt(key.replace('chara-ext-asset_:', ''), 10);
            if (!isNaN(assetIndex)) {
                // Base64 디코딩
                const byteString = atob(value);
                const byteArray = new Uint8Array(byteString.length);
                for (let i = 0; i < byteString.length; i++) {
                    byteArray[i] = byteString.charCodeAt(i);
                }
                assets[assetIndex] = byteArray;
            }
        } else if (key === 'chara' || key === 'ccv3') {
            mainDataStr = value;
        }
    });

    if (Object.keys(assets).length === 0) {
        updateStatus("경고: PNG 파일에서 추출할 에셋을 찾지 못했습니다.", "warning");
        return;
    }

    let charData = null;
    if (mainDataStr) {
        try {
            if (!mainDataStr.startsWith('rcc||')) {
                const decoded = atob(mainDataStr);
                charData = JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, c => c.charCodeAt(0))));
            }
        } catch (e) {
            console.warn("PNG 메인 데이터 파싱 실패:", e);
        }
    }

    const foundIndices = new Set();
    if (charData) {
        const assetList = (charData.data?.assets || []).concat(charData.data?.extensions?.risuai?.additionalAssets || []).concat(charData.data?.extensions?.risuai?.emotions || []);
        
        assetList.forEach(item => {
            let uri, name, ext;
            if (typeof item === 'object' && item !== null) { // v3
                ({ uri, name, ext } = item);
            } else if (Array.isArray(item) && item.length >= 2) { // v2
                name = item[0].split('/').pop().replace(/\.[^/.]+$/, "");
                uri = item[1];
                ext = item.length > 2 ? item[2] : 'dat';
            } else {
                return;
            }
            
            if (uri && uri.startsWith('__asset:')) {
                const assetIndex = parseInt(uri.split(':').pop(), 10);
                if (assets[assetIndex]) {
                    let finalName = name;
                    if (ext && !name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
                        finalName = `${name}.${ext}`;
                    }
                    finalZip.file(finalName, assets[assetIndex]);
                    foundIndices.add(assetIndex);
                }
            }
        });
    }

    // 이름 없는 나머지 에셋 처리
    for (const [index, data] of Object.entries(assets)) {
        if (!foundIndices.has(parseInt(index, 10))) {
            const ext = detectImageExtension(data);
            finalZip.file(`asset_${index}${ext}`, data);
        }
    }
}

// --- ZIP 다운로드 함수 ---
function downloadZip() {
    if (finalZip && Object.keys(finalZip.files).length > 0) {
        const originalFileName = fileInput.files[0].name.replace(/\.[^/.]+$/, "");
        finalZip.generateAsync({ type: 'blob' }).then(content => {
            const url = URL.createObjectURL(content);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${originalFileName}_assets.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        });
    }
}