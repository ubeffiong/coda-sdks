// In the CODA monorepo, CODA-Web serves the drop-in module at /connect.js; keep it in step with
// this build. In the standalone coda-sdks repository there is no CODA-Web, so nothing is copied.
import { copyFileSync, existsSync } from 'node:fs';

const web = '../../CODA-Web/public';
if (existsSync(web)) copyFileSync('dist/connect.js', `${web}/connect.js`);
