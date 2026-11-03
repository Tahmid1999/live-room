import type { Metadata } from 'next';
import { Publisher } from './Publisher';

// Not linked from anywhere: only the house worker opens this, with a token in
// the URL fragment. The robots tag is for a crawler that finds it anyway.
export const metadata: Metadata = { title: 'house', robots: { index: false, follow: false } };

export default function HousePage() {
  return <Publisher />;
}
