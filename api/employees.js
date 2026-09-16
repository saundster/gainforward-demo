/* Ripple: Darwinbox employee feed, server-side only.
   This is a Vercel Function — it runs on Vercel's server, never in the
   visitor's browser, which is the whole point: the Darwinbox credentials
   below are read from environment variables (set in the Vercel dashboard,
   never committed to this repo) and never travel to the client. The
   browser only ever talks to this endpoint, never to Darwinbox directly.

   STATUS: scaffold, not yet verified against Darwinbox's own API
   reference (their docs portal needs a login I don't have). The request
   shape and field-name mapping below follow the pattern used by public
   third-party Darwinbox integration guides, not Darwinbox's authoritative
   spec — confirm both against your actual account before relying on this. */

export default async function handler(req, res) {
  const { DARWINBOX_SUBDOMAIN, DARWINBOX_USERNAME, DARWINBOX_PASSWORD, DARWINBOX_API_KEY, DARWINBOX_DATASET_KEY } = process.env;

  if (!DARWINBOX_SUBDOMAIN || !DARWINBOX_USERNAME || !DARWINBOX_PASSWORD || !DARWINBOX_API_KEY) {
    res.status(500).json({ error: "Darwinbox environment variables aren't configured on the server yet." });
    return;
  }

  try {
    const basicAuth = Buffer.from(`${DARWINBOX_USERNAME}:${DARWINBOX_PASSWORD}`).toString("base64");

    // TODO(verify): confirm this exact path with Darwinbox/your account
    // manager. Third-party guides document POST https://{subdomain}.darwinbox.in/masterapi/employee
    const darwinboxRes = await fetch(`https://${DARWINBOX_SUBDOMAIN}.darwinbox.in/masterapi/employee`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        api_key: DARWINBOX_API_KEY,
        // Some Darwinbox setups require a separate datasetKey to say which
        // data view to pull; omit this field entirely if yours doesn't.
        ...(DARWINBOX_DATASET_KEY ? { datasetKey: DARWINBOX_DATASET_KEY } : {}),
      }),
    });

    if (!darwinboxRes.ok) {
      const details = await darwinboxRes.text();
      res.status(darwinboxRes.status).json({ error: "Darwinbox rejected the request", details });
      return;
    }

    const raw = await darwinboxRes.json();

    // TODO(verify): these field names are a best guess at common Darwinbox
    // conventions, not confirmed against a real response from your account.
    // Once you can see one real record's shape (with values redacted), this
    // mapping needs to be corrected to match it exactly.
    const records = Array.isArray(raw) ? raw : raw.data || raw.employees || [];
    const employees = records.map((e) => ({
      id: e.employee_id || e.emp_id || e.id,
      fullName: e.name || e.full_name || e.employee_name,
      email: e.email || e.official_email,
      department: e.department || e.department_name,
      geography: e.location || e.region || e.work_location,
    }));

    res.status(200).json({ employees });
  } catch (err) {
    res.status(500).json({ error: "Unexpected error calling Darwinbox", details: err.message });
  }
}
