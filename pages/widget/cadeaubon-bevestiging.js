// Redirect-pagina na de Mollie-betaling van een cadeaubon. Bewust geen
// paymentId/code in de URL of hier opgevraagd — de effectieve code wordt
// pas gegenereerd zodra de Mollie-webhook de betaling bevestigt, en meteen
// naar de koper gemaild (zie lib/store-sql.js -> fulfillGiftCardPurchase()).
export default function CadeaubonBevestiging() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "center", padding: 24 }}>
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ color: "var(--accent)" }}>Bedankt voor je aankoop!</h1>
        <p>Zodra je betaling bevestigd is, ontvang je de cadeaubon-code per e-mail.</p>
        <p style={{ marginTop: 16 }}>
          <a href="/widget" style={{ color: "var(--accent)" }}>← Terug naar boeken</a>
        </p>
      </div>
    </div>
  );
}
