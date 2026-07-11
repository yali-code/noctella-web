const FAQ_ITEMS: Array<{ question: string; answer: string }> = [
  {
    question: "Are the objects in your collection authentic?",
    answer: "Each listing includes the condition, materials, and details we have available for that piece.",
  },
  {
    question: "Can I make an offer on an item?",
    answer: "Items marked \"Make Offer\" accept offers directly from the product page.",
  },
  {
    question: "Do you ship internationally?",
    answer: "Shipping details vary by item and destination — see our Shipping & Delivery page for more.",
  },
  {
    question: "Who pays customs duties?",
    answer:
      "Buyers are responsible for any customs duties, import taxes, or local charges that may occur during international shipping.",
  },
];

export default function FaqPage() {
  return (
    <section style={{ padding: "60px 40px", maxWidth: 720 }}>
      <h1>Frequently Asked Questions</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {FAQ_ITEMS.map((item) => (
          <div key={item.question}>
            <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>{item.question}</h2>
            <p style={{ margin: 0, color: "var(--noctella-ivory)", lineHeight: 1.6 }}>{item.answer}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
