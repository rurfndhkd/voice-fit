// Vercel CLI 가 PC 이름(한글)을 HTTP 헤더에 넣다가 실패하는 문제를 피하기 위한 보정.
// 이 프로세스 안에서만 PC 이름을 영문으로 보이게 한다. 실제 PC 이름은 바뀌지 않는다.
const os = require('os');
os.hostname = () => 'voicefit-dev-pc';
