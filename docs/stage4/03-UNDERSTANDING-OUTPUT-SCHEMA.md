# Output Schema

The persisted payload is JSON under `profile_field_meta_json._understanding.payload`. Its metadata records status, input fingerprint, profile version, provider, model, prompt version, timestamps, duration, evidence count and quality results.

The API never asks the frontend to parse Markdown. `GET /api/customers/:id/understanding` returns the structured payload, safe evidence summaries and status. `POST /api/customers/:id/understanding/refresh` returns the same envelope.
