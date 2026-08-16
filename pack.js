// 打包脚本：绿色免安装，缓存/下载全部限制在 E 盘
const { packager } = require('@electron/packager');
const path = require('path');

(async () => {
  const paths = await packager({
    dir: __dirname,
    name: '麻衣桌宠',
    platform: 'win32',
    arch: 'x64',
    out: path.join(__dirname, 'dist'),
    overwrite: true,
    asar: false, // 不打包进 asar，保证 PowerShell 能直接读 scripts/foreground.ps1
    ignore: [
      /[\\/]data([\\/]|$)/,
      /\.log$/,
      /\.npmrc$/,
      /[\\/]dist([\\/]|$)/,
      /preview\.png$/,
      /screenshot\.js$/
    ],
    download: {
      cacheRoot: 'E:\\桌宠\\.electron-cache',
      mirrorOptions: { mirror: 'https://npmmirror.com/mirrors/electron/' }
    }
  });
  console.log('PACKED:');
  paths.forEach(p => console.log(p));
})().catch(err => { console.error(err); process.exit(1); });
