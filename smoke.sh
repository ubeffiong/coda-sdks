#!/usr/bin/env bash
# Smoke-test the TypeScript and Python SDKs against a running CODA (e.g. the docker-compose stack).
#   CODA_URL=http://localhost:5080 CODA_TOKEN=<TerminologyReader token> sdks/smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${CODA_URL:?set CODA_URL}" "${CODA_TOKEN:?set CODA_TOKEN}"
(cd typescript && npm run --silent build)
node --input-type=module -e "
import { CodaClient } from './typescript/dist/index.js';
const c = new CodaClient({ baseUrl: process.env.CODA_URL, token: process.env.CODA_TOKEN });
const s = await c.search('type 2 diabetes', [{ system: 'urn:coda:fixture:clinical' }], { count: 3 });
console.log('typescript: search ->', s.groups[0].candidates[0]?.code);"
python -I -c "
import os, sys; sys.path.insert(0, 'python/src')
from coda_client import CodaClient
r = CodaClient(os.environ['CODA_URL'], os.environ['CODA_TOKEN']).validate('urn:coda:fixture:clinical', 'FX-111200')
print('python: validate ->', r['outcome'])"
