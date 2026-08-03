import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from './config/api';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

export default function LoginPage({ setUser }) {
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const render = () => {
      if (!window.google || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response) => {
          try {
            const res = await api.post('/auth/google', { credential: response.credential });
            setUser(res.data);
          } catch (e) {
            console.error('Google login failed', e);
          }
        },
      });
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: 'filled_blue',
        size: 'large',
        shape: 'pill',
        width: 280,
      });
    };

    if (window.google) {
      render();
    } else {
      // GIS script tag loads async — poll briefly until it's ready.
      const interval = setInterval(() => {
        if (window.google) {
          clearInterval(interval);
          render();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [setUser]);

  return (
    <div className="relative flex items-center justify-center w-full h-screen overflow-hidden bg-[#050b1a] text-gray-100">
      {/* Ambient dark-blue glow background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -left-40 w-[32rem] h-[32rem] bg-blue-700/25 rounded-full blur-[120px]" />
        <div className="absolute -bottom-40 -right-40 w-[32rem] h-[32rem] bg-indigo-600/20 rounded-full blur-[120px]" />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              'linear-gradient(#1e3a8a 1px, transparent 1px), linear-gradient(90deg, #1e3a8a 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-8 px-10 py-12 rounded-2xl border border-blue-900/40 bg-[#0a1428]/80 backdrop-blur-xl shadow-[0_0_60px_-15px_rgba(37,99,235,0.35)] max-w-sm w-full mx-4">
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-700 flex items-center justify-center shadow-lg shadow-blue-900/50">
            <Sparkles size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">SysAid AI</h1>
          <p className="text-sm text-blue-200/60 text-center leading-relaxed">
            Sign in to design, simulate, and save your system architectures.
          </p>
        </div>

        <div ref={buttonRef} />

        {!GOOGLE_CLIENT_ID && (
          <p className="text-xs text-red-400 text-center">
            Google Sign-In is not configured (missing VITE_GOOGLE_CLIENT_ID).
          </p>
        )}

        <p className="text-[11px] text-blue-300/30 text-center">
          Your chat history and diagrams are private to your account.
        </p>
      </div>
    </div>
  );
}
