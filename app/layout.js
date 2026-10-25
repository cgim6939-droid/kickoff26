import { Barlow_Condensed } from 'next/font/google';
import './globals.css';

// 영문/숫자용 각진 스포츠 폰트 (한글은 시스템 글꼴로 표시)
const display = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  variable: '--font-display',
});

export const metadata = {
  title: 'KICKOFF 26',
  description: '브라우저에서 즐기는 3D 축구 게임',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
