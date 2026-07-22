/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, FormEvent } from 'react';
import { ArrowRight, LockKeyhole, ShieldAlert, Server } from 'lucide-react';
import { User } from '../types';
import ingLogo from './ING_logo.svg';

interface KibanaLoginProps {
  onLoginSuccess: (user: User) => void;
}

export default function KibanaLogin({ onLoginSuccess }: KibanaLoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!username.trim() || !password.trim()) {
      setErrorMessage('Username and password are required.');
      return;
    }

    setIsLoading(true);
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || data.status !== 'success') {
          throw new Error(data.error || 'Authentication failed.');
        }
        onLoginSuccess(data.user);
      })
      .catch((err) => setErrorMessage(err.message))
      .finally(() => setIsLoading(false));
  };

  return (
    <div className="min-h-screen w-screen bg-[#02060d] text-slate-100 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-lg shadow-2xl p-6 flex flex-col gap-6">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <img src={ingLogo} alt="ING" className="h-8 w-8 shrink-0" />
            <div>
              <h1 className="text-sm font-bold tracking-wider text-white uppercase leading-none">RELEASE LOGS</h1>
              <span className="text-xs text-[#00a9e5] font-mono uppercase">AZURE DEVOPS</span>
            </div>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white">Sign in</h2>
            <p className="text-xs text-slate-400 mt-1">Use a local account or an LDAP directory user.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {errorMessage && (
            <div className="bg-rose-950/40 border border-rose-500/30 text-rose-300 p-3 rounded text-xs flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-[10px] uppercase font-bold text-slate-400">Username</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full text-xs font-mono bg-slate-950 border border-slate-800 text-white p-2.5 rounded focus:outline-none focus:border-[#006bb4] focus:ring-1 focus:ring-[#006bb4] transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-[10px] uppercase font-bold text-slate-400">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full text-xs font-mono bg-slate-950 border border-slate-800 text-white p-2.5 rounded focus:outline-none focus:border-[#006bb4] focus:ring-1 focus:ring-[#006bb4] transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-[#006bb4] hover:bg-[#005a96] text-white text-xs font-semibold py-2.5 rounded transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Server className="w-3.5 h-3.5 animate-spin text-white" />
                Signing in...
              </>
            ) : (
              <>
                Sign in
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
