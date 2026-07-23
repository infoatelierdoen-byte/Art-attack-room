import { useRouter } from "next/router";

// Redirect-pagina na Mollie-betaling. In productie: status opvragen via
// GET /api/bookings/:id (nog te bouwen) i.p.v. enkel op de query-param te
// vertrouwen — Mollie's webhook blijft de bron van waarheid.
export default function Bevestiging() {
  const router = useRouter();
  const { booking, mock_payment } = router.query;

  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "center", padding: 24 }}>
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ color: "var(--accent)" }}>Bedankt voor je boeking!</h1>
        <p>Boeking #{booking} is bevestigd. Je ontvangt zo een bevestigingsmail.</p>
        {mock_payment && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            (Dev-modus: mock-betaling {mock_payment} — geen echte transactie.)
          </p>
        )}
      </div>
    </div>
  );
}
