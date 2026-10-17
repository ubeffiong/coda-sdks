# Integrating an EMR with CODA

This guide adds **Search with CODA** to an EMR, lab, pharmacy or any other clinical web system. The clinician highlights a phrase, right-clicks, picks codes in the CODA window, and the codes come back into the field. Your server also receives a signed webhook, so the record is durable.

```
 EMR page                         CODA window                         Your server
 ────────                         ───────────                         ───────────
 highlight "diabetic nephropathy"
 right-click ▸ Search with CODA ─▶ search, assistant, concept detail
                                   ✓ GB61.Z  ▸ Send to <your EMR>
 field ◀── codes (postMessage) ◀──┘                 │
                                                    └── webhook ──────▶ verify ▸ save by patientRef
```

You need three things from a CODA administrator (Developer hub ▸ **Connected apps**):

1. **An app id.** Register your system and the web origins it runs on. CODA sends results only to those origins.
2. **A webhook endpoint and its signing secret** (Developer hub ▸ **Webhooks**). The secret is shown once.
3. **The CODA address**, for example `https://coda.hospital.ng`.

Test everything first in the Developer hub's **EMR sandbox** and **Simulator**.

---

## 1. Plain JavaScript (any web page)

No build step: CODA serves the module at `/connect.js`.

```html
<textarea id="note">Known type 2 diabetes. Diabetic nephropathy noted last year.</textarea>
<input id="diagnosis" placeholder="Right-click selected text to code it">

<script type="module">
  import { CodaConnect, CodaConnectCancelled } from 'https://coda.hospital.ng/connect.js';

  const coda = new CodaConnect({
    codaUrl: 'https://coda.hospital.ng',
    appId: '<your app id>',
    display: 'modal', // in-page dialog; 'popup' opens a window
    defaults: { purpose: 'diagnosis', maxSelections: 3 },
  });

  // Right-click on selected text ▸ "Search with CODA" (Ctrl+Shift+K works too).
  coda.attachContextMenu(document.body, {
    // Opaque tokens your server issued for this chart (see "Patient context" below).
    context: () => ({ patientRef: window.chart.patientRef, encounterRef: window.chart.encounterRef }),
    onSelect: (result, field) => coda.insertInto(field, result.selections[0], 'display-code'),
    onError: (e) => console.error('CODA:', e),
  });

  // Or from your own button:
  document.querySelector('#code-it')?.addEventListener('click', async () => {
    try {
      const result = await coda.pick({ text: window.getSelection().toString() });
      console.log(result.selections); // [{ system, version, code, display, coding, cwe }]
    } catch (e) {
      if (!(e instanceof CodaConnectCancelled)) throw e;
    }
  });
</script>
```

Insert formats: `display-code` ("Type 2 diabetes mellitus (5A11)"), `display`, `code`, `cwe` (HL7 v2), `fhir-coding` (JSON), or your own function.

## 2. React

Install the SDK (`npm install @coda-terminology/client`, or the one-line installer in the [README](../README.md)), then use a hook and a small field component.

```tsx
// useCodaConnect.ts
import { useEffect, useMemo, useRef } from 'react';
import { CodaConnect, CodaConnectCancelled, type ConnectResult, type PickOptions } from '@coda-terminology/client/connect';

export function useCodaConnect(appId: string, codaUrl = import.meta.env.VITE_CODA_URL) {
  const coda = useMemo(() => new CodaConnect({ codaUrl, appId, display: 'modal', defaults: { purpose: 'diagnosis' } }), [appId, codaUrl]);

  /** Opens CODA for `text`; resolves with the selection, or null when the clinician cancels. */
  async function pick(options: PickOptions): Promise<ConnectResult | null> {
    try {
      return await coda.pick(options);
    } catch (e) {
      if (e instanceof CodaConnectCancelled) return null;
      throw e;
    }
  }

  /** Adds right-click "Search with CODA" inside the element the ref points to. */
  function useContextMenu<T extends HTMLElement>(context: () => Omit<PickOptions, 'text'>, onSelect: (r: ConnectResult) => void) {
    const ref = useRef<T>(null);
    useEffect(() => {
      if (!ref.current) return;
      return coda.attachContextMenu(ref.current, { context, onSelect: (r) => onSelect(r) });
    }, [context, onSelect]);
    return ref;
  }

  return { pick, useContextMenu };
}
```

```tsx
// CodedField.tsx
import { useState } from 'react';
import type { ConnectSelection } from '@coda-terminology/client/connect';
import { useCodaConnect } from './useCodaConnect';
import './CodedField.css';

interface Props {
  label: string;
  appId: string;
  patientRef: string;   // opaque token from your server, never an MRN
  encounterRef: string;
  onChange: (codes: ConnectSelection[]) => void;
}

export function CodedField({ label, appId, patientRef, encounterRef, onChange }: Props) {
  const { pick } = useCodaConnect(appId);
  const [text, setText] = useState('');
  const [codes, setCodes] = useState<ConnectSelection[]>([]);
  const [busy, setBusy] = useState(false);

  async function code() {
    setBusy(true);
    const result = await pick({ text, patientRef, encounterRef, maxSelections: 3 }).finally(() => setBusy(false));
    if (result) {
      setCodes(result.selections);
      onChange(result.selections);
    }
  }

  return (
    <div className="coded-field">
      <label>
        {label}
        <div className="coded-field__row">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe the diagnosis" />
          <button type="button" onClick={() => void code()} disabled={busy || !text.trim()}>
            {busy ? 'Coding…' : 'Code with CODA'}
          </button>
        </div>
      </label>
      {codes.length > 0 && (
        <ul className="coded-field__codes">
          {codes.map((c) => <li key={`${c.system}|${c.code}`}><code>{c.code}</code> {c.display} <small>{c.systemKey} · {c.version}</small></li>)}
        </ul>
      )}
    </div>
  );
}
```

```css
/* CodedField.css: optional; CODA's own window needs no CSS from you. */
.coded-field { display: flex; flex-direction: column; gap: 0.4rem; font: 14px/1.4 system-ui, sans-serif; }
.coded-field__row { display: flex; gap: 0.5rem; margin-top: 0.25rem; }
.coded-field__row input { flex: 1; padding: 0.5rem 0.65rem; border: 1px solid #cfd6de; border-radius: 8px; }
.coded-field__row button { padding: 0.5rem 0.9rem; border: 0; border-radius: 8px; background: #0b6e69; color: #fff; cursor: pointer; }
.coded-field__row button:disabled { opacity: 0.6; cursor: default; }
.coded-field__codes { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
.coded-field__codes li { padding: 0.2rem 0.6rem; border-radius: 999px; background: #e7f2f1; border: 1px solid #b9dad7; }
.coded-field__codes code { font-weight: 700; color: #0b6e69; }
.coded-field__codes small { color: #5f6b7a; }
```

With `display: 'modal'`, CODA must allow your origin in its `frame-ancestors` policy. Ask the CODA administrator, or use `display: 'popup'`.

## 3. Patient context (HIPAA)

CODA never needs to know who the patient is. Send **opaque tokens your EMR generates and maps**, never identifiers:

- `patientRef` and `encounterRef` must be random values, for example `crypto.randomUUID()`, stored with the chart in your EMR.
- They **must not be derived from identifiers**: no MRN, no hash of an MRN, no name and no date of birth (45 CFR 164.514(c)).
- CODA rejects values that look like identifiers (record numbers, dates, spaces, `@`) with `400 INVALID_REQUEST`.
- Send only the clinical phrase as `text`. CODA strips identifiers copied along by mistake, but that is a safety net.
- Results and webhooks echo your tokens, so you can file the codes. Webhooks never carry free text.

```ts
// On your server: one random token per patient (and per encounter), mapped in your own database.
const patientRef = await db.codaRefs.findOrCreate(patient.id, () => `pt_${crypto.randomUUID()}`);
```

Full guidance: `docs/security/hipaa-emr-integration.md` in the CODA platform repository (ask your CODA administrator).

## 4. Receive and verify the webhook

Every completed selection is delivered as `connect.selection.completed`. Body:

```json
{ "id": "evt_…", "type": "connect.selection.completed", "timestamp": "…",
  "data": { "sessionId": "…", "appId": "…", "status": "completed", "purpose": "diagnosis",
            "patientRef": "pt_3f2b…", "encounterRef": "enc_9a1c…",
            "selections": [{ "system": "http://id.who.int/icd/release/11/mms", "version": "2025-01", "code": "GB61.Z",
                             "display": "Chronic kidney disease, stage unspecified", "cwe": "GB61.Z^…^icd11-mms" }] } }
```

Verify the signature on the **raw** body, reject anything older than five minutes, answer `2xx` quickly, and de-duplicate on the `webhook-id` header. CODA retries for up to 12 hours.

### TypeScript (Node, Express)
```ts
import express from 'express';
import { verifyWebhook } from '@coda-terminology/client';

const app = express();
app.post('/coda/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const body = req.body.toString('utf8');
  if (!(await verifyWebhook(process.env.CODA_WEBHOOK_SECRET!, req.headers, body))) return res.sendStatus(401);
  const event = JSON.parse(body);
  if (event.type === 'connect.selection.completed') await saveCodes(event.data.patientRef, event.data.encounterRef, event.data.selections);
  res.sendStatus(204);
});
```

### Python (FastAPI)
```python
from fastapi import FastAPI, Request, Response
from coda_client import verify_webhook
import json, os

app = FastAPI()

@app.post("/coda/webhooks")
async def coda_webhook(request: Request):
    body = (await request.body()).decode("utf-8")
    if not verify_webhook(os.environ["CODA_WEBHOOK_SECRET"], dict(request.headers), body):
        return Response(status_code=401)
    event = json.loads(body)
    if event["type"] == "connect.selection.completed":
        save_codes(event["data"]["patientRef"], event["data"]["encounterRef"], event["data"]["selections"])
    return Response(status_code=204)
```

### C# (ASP.NET Core minimal API)
```csharp
using Coda.Client;
using System.Text.Json;

app.MapPost("/coda/webhooks", async (HttpRequest request, ICodeStore store) =>
{
    using var reader = new StreamReader(request.Body);
    var body = await reader.ReadToEndAsync();
    var headers = request.Headers.Select(h => KeyValuePair.Create(h.Key, h.Value.ToString()));
    if (!CodaWebhooks.Verify(builder.Configuration["Coda:WebhookSecret"]!, headers, body)) return Results.Unauthorized();

    using var doc = JsonDocument.Parse(body);
    if (doc.RootElement.GetProperty("type").GetString() == "connect.selection.completed")
        await store.SaveAsync(doc.RootElement.GetProperty("data"));
    return Results.NoContent();
});
```

### Java (Spring Boot)
```java
import org.coda.client.CodaWebhooks;

@RestController
class CodaWebhookController {
    @PostMapping(value = "/coda/webhooks", consumes = "application/json")
    ResponseEntity<Void> receive(@RequestHeader Map<String, String> headers, @RequestBody String body) throws Exception {
        if (!CodaWebhooks.verify(System.getenv("CODA_WEBHOOK_SECRET"), headers, body)) return ResponseEntity.status(401).build();
        JsonNode event = new ObjectMapper().readTree(body);
        if ("connect.selection.completed".equals(event.get("type").asText())) codes.save(event.get("data"));
        return ResponseEntity.noContent().build();
    }
}
```

### Go (net/http)
```go
import coda "github.com/ubeffiong/coda-sdks/go"

http.HandleFunc("/coda/webhooks", func(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    if !coda.VerifyWebhook(os.Getenv("CODA_WEBHOOK_SECRET"), r.Header, body, time.Now(), 5*time.Minute) {
        http.Error(w, "bad signature", http.StatusUnauthorized)
        return
    }
    var event struct{ Type string; Data json.RawMessage }
    _ = json.Unmarshal(body, &event)
    if event.Type == "connect.selection.completed" { saveCodes(event.Data) }
    w.WriteHeader(http.StatusNoContent)
})
```

### Rust (axum)
```rust
use axum::{http::{HeaderMap, StatusCode}, routing::post, Router};

async fn coda_webhook(headers: HeaderMap, body: String) -> StatusCode {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let secret = std::env::var("CODA_WEBHOOK_SECRET").unwrap();
    if !coda_client::verify_webhook(&secret, &h("webhook-id"), &h("webhook-timestamp"), &h("webhook-signature"), &body, now, 300) {
        return StatusCode::UNAUTHORIZED;
    }
    let event: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    if event["type"] == "connect.selection.completed" { save_codes(&event["data"]); }
    StatusCode::NO_CONTENT
}

let app = Router::new().route("/coda/webhooks", post(coda_webhook));
```

## 5. Check codes before you save them (optional)

Codes coming back from CODA are already validated against their release. When codes reach your system some other way, validate them with any SDK:

```ts
import { CodaClient } from '@coda-terminology/client';
const coda = new CodaClient({ baseUrl: 'https://coda.hospital.ng', token: () => getServiceToken() });
const r = await coda.validate('http://id.who.int/icd/release/11/mms', 'GB61.Z');
if (r.outcome !== 'valid') throw new Error(`Not a valid code: ${r.outcome}`);
```

```python
r = CodaClient("https://coda.hospital.ng", token=get_service_token).validate("http://loinc.org", "2345-7", display="Glucose")
```

## 6. Go live

- [ ] The app is registered with your production origins only.
- [ ] The webhook endpoint is https, verifies signatures and de-duplicates on `webhook-id`.
- [ ] `patientRef` and `encounterRef` are random tokens mapped in your EMR. Phrases carry no identifiers.
- [ ] You tried the flow in the CODA **EMR sandbox** and replayed events from the **Simulator**.
- [ ] A Business Associate Agreement is in place wherever PHI could reach CODA.
