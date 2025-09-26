import extract from 'https://esm.sh/png-chunks-extract';

// --- DOM 요소 가져오기 ---
const dropZone = document.getElementById('cardDropZone');
const fileInput = document.getElementById('cardFileInput');
const statusDiv = document.getElementById('cardStatus');
const downloadAllBtn = document.getElementById('cardDownloadAllBtn');

let finalZip = null;

// --- 이벤트 리스너 설정 ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFile(e.target.files[0]); });
downloadAllBtn.addEventListener('click', downloadZip);

// --- 헬퍼 함수 ---
function updateStatus(message, type = '') {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
}

/**
 * ✨ [새로 추가] 파일의 첫 8바이트를 읽어 PNG인지 확인하는 함수
 * @param {File} file - 확인할 파일 객체
 * @returns {Promise<boolean>} PNG 파일이면 true를 반환
 */
async function isPng(file) {
    if (file.size < 8) return false;
    const pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const fileSlice = file.slice(0, 8); // 파일의 첫 8바이트만 잘라냄
    const buffer = await fileSlice.arrayBuffer();
    const uint8array = new Uint8Array(buffer);

    // 8바이트를 순서대로 비교
    for (let i = 0; i < pngHeader.length; i++) {
        if (uint8array[i] !== pngHeader[i]) {
            return false;
        }
    }
    return true;
}


// --- ✨ [수정됨] 메인 파일 처리 로직 ---
async function handleFile(file) {
    updateStatus(`'${file.name}' 처리 중...`);
    downloadAllBtn.style.display = 'none';
    finalZip = new JSZip();

    try {
        // 1. 파일 내용 기반으로 PNG인지 먼저 확인
        if (await isPng(file)) {
            console.log("PNG 형식으로 처리합니다.");
            await handlePng(file);
        } 
        // 2. PNG가 아니라면 ZIP(.charx)으로 처리 시도
        else {
            console.log("ZIP(.charx) 형식으로 처리합니다.");
            try {
                await handleCharx(file);
            } catch (zipError) {
                // ZIP으로 처리 실패 시, 지원하지 않는 파일로 최종 판단
                console.error("ZIP으로 처리 실패:", zipError);
                throw new Error("지원하지 않는 파일 형식입니다. PNG 헤더를 포함하거나 유효한 ZIP(.charx) 형식이 아닙니다.");
            }
        }
        
        const fileCount = Object.keys(finalZip.files).length;
        if (fileCount > 0) {
            updateStatus(`추출 완료! 총 ${fileCount}개의 파일을 찾았습니다.`, 'success');
            downloadAllBtn.style.display = 'block';
        } else {
            updateStatus("완료되었지만, 추출할 에셋을 파일에서 찾지 못했습니다.", '');
        }

    } catch (error) {
        updateStatus(`오류 발생: ${error.message}`, 'error');
        console.error(error);
    }
}


// --- .charx (ZIP) 파일 처리 (수정 없음) ---
async function handleCharx(file) {
    // JSZip.loadAsync는 ZIP 파일이 아니면 여기서 에러를 발생시킴
    const zip = await JSZip.loadAsync(file);
    const cardJsonFile = zip.file('card.json');
    if (!cardJsonFile) {
        throw new Error("'card.json'을 찾을 수 없습니다.");
    }

    const charData = JSON.parse(await cardJsonFile.async('string'));
    const assetsInfo = charData?.data?.assets || [];

    if (assetsInfo.length === 0) return;

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


// --- .png 카드 파일 처리 (수정 없음) ---
async function handlePng(file) {
    const buffer = await file.arrayBuffer();
    const chunks = extract(new Uint8Array(buffer));
    const textChunks = chunks.filter(chunk => chunk.name === 'tEXt');
    
    // (이하 로직은 기존과 동일)
    let mainDataStr = null;
    const assets = {};

    textChunks.forEach(chunk => {
        try {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            const decodedString = decoder.decode(chunk.data);
            const nullIndex = decodedString.indexOf('\x00');
            if (nullIndex === -1) return;

            const key = decodedString.substring(0, nullIndex);
            const value = decodedString.substring(nullIndex + 1);

            if (key.startsWith('chara-ext-asset_')) {
                const assetIndex = parseInt(key.replace('chara-ext-asset_:', ''), 10);
                if (!isNaN(assetIndex)) {
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
        } catch (e) {
            console.warn("UTF-8 디코딩 실패, tEXt 청크를 건너뜁니다:", e);
        }
    });

    if (Object.keys(assets).length === 0) return;

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
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                ({ uri, name, ext } = item);
            } else if (Array.isArray(item) && item.length >= 2) {
                const pathParts = item[0].split(/[\\/]/);
                name = pathParts.pop().replace(/\.[^/.]+$/, "");
                uri = item[1];
                ext = item.length > 2 ? item[2] : 'dat';
            } else { return; }
            
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

    // 이름 없는 나머지 에셋 처리...
    const detectImageExtension = (data) => {
        if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return '.png';
        if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return '.jpg';
        if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return '.webp';
        if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return '.gif';
        return '.dat';
    };

    for (const [index, data] of Object.entries(assets)) {
        if (!foundIndices.has(parseInt(index, 10))) {
            const ext = detectImageExtension(data);
            finalZip.file(`asset_${index}${ext}`, data);
        }
    }
}


// --- ZIP 다운로드 함수 (수정 없음) ---
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