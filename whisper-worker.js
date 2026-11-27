import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';
env.allowLocalModels = false;
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ status: '한국어 전사에 사용할 Whisper Small 모델을 불러오는 중입니다.' });
    const whisper = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', { device: 'wasm', dtype: 'q8' });
    self.postMessage({ status: '전사 중입니다. 긴 녹음은 시간이 걸릴 수 있습니다.' });
    const result = await whisper(data, {
      language: 'korean', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5
    });
    self.postMessage({ text: result.text.trim() });
  } catch {
    self.postMessage({ error: 'Whisper 전사에 실패했습니다. 네트워크와 브라우저 메모리를 확인하세요.' });
  }
};
