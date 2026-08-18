const store = require("../../../../lib/store-sql");
const { requireStaff } = require("../../../../lib/auth");

// PATCH  /api/admin/staff-shifts/:id  body: { dateISO, staffName, start, end, note }
// DELETE /api/admin/staff-shifts/:id
export default async function handler(req, res) {
  const session = requireStaff(req, res);
  if (!session) return;

  const { id } = req.query;

  if (req.method === "PATCH") {
    const { dateISO, staffName, start, end, note } = req.body || {};
    try {
      const shift = await store.updateStaffShift(id, { dateISO, staffName, start, end, note });
      return res.status(200).json(shift);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      await store.deleteStaffShift(id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
