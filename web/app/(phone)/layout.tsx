export default function PhoneLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="shell">{children}</div>
      <footer className="foot">house streams are automated · numbers are measured</footer>
    </>
  );
}
