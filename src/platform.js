if (process.platform === 'win32') module.exports = require('./native-windows');
else if (process.platform === 'darwin') module.exports = require('./native-mac');
else throw new Error('Americano는 Windows와 macOS를 지원합니다.');
