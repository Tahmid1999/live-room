export default function PhoneLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="shell">{children}</div>
      <footer className="foot">house streams: generated test card and tone · numbers are measured</footer>
    </>
  );
}
