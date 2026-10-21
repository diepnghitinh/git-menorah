// Chạy git-server.mjs ngay trong tiến trình này và thoát theo app: stdin là ống nối với app,
// app tắt kiểu gì (kể cả crash, Force Quit, kill -9) thì hệ điều hành đóng ống và ta nhận EOF.
// Không có lớp này, server con mồ côi giữ cổng 4991–4995 và lần mở sau không khởi động được.
//   Electron (ELECTRON_RUN_AS_NODE) server-guard.mjs <git-server.mjs> --port=<cổng>
import { pathToFileURL } from 'node:url';

const [server, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], server, ...rest];
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
await import(pathToFileURL(server).href);
