import React from 'react';
import { Settings, Save } from 'lucide-react';
import { useStore, useSettings } from '../store/index.ts';
import { useOllamaModels } from '../hooks/useApi.ts';
import toast from 'react-hot-toast';

export default function SettingsPage() {
  const settings = useSettings();
  const { updateSettings } = useStore();
  const { data: models } = useOllamaModels();

  const handleSave = () => {
    toast.success('Settings saved!');
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-gray-500 mt-1">Configure AetherDev to match your workflow</p>
      </div>

      {/* LLM Settings */}
      <section className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Settings className="w-4 h-4 text-aether-400" /> LLM Configuration
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Provider</label>
            <select
              value={settings.llmProvider}
              onChange={e => updateSettings({ llmProvider: e.target.value })}
              className="input text-sm"
            >
              <option value="ollama">Ollama (Local — Recommended)</option>
              <option value="openai">OpenAI Compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="local">LM Studio / LocalAI</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Model</label>
            {models?.length ? (
              <select value={settings.ollamaModel} onChange={e => updateSettings({ ollamaModel: e.target.value })} className="input text-sm">
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                value={settings.ollamaModel}
                onChange={e => updateSettings({ ollamaModel: e.target.value })}
                placeholder="codellama:13b"
                className="input text-sm font-mono"
              />
            )}
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">API URL</label>
          <input
            value={settings.apiUrl}
            onChange={e => updateSettings({ apiUrl: e.target.value })}
            className="input text-sm font-mono"
          />
        </div>
      </section>

      {/* Pipeline Defaults */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">Pipeline Defaults</h2>
        {[
          { key: 'autoReview', label: 'Auto-run code review', desc: 'Automatically review generated code' },
          { key: 'autoTest', label: 'Auto-generate tests', desc: 'Generate tests for new code' },
          { key: 'streamResponse', label: 'Stream responses', desc: 'Show AI responses as they are generated' },
        ].map(opt => (
          <label key={opt.key} className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-sm text-gray-200">{opt.label}</p>
              <p className="text-xs text-gray-500">{opt.desc}</p>
            </div>
            <div
              onClick={() => updateSettings({ [opt.key]: !settings[opt.key as keyof typeof settings] })}
              className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${settings[opt.key as keyof typeof settings] ? 'bg-aether-600' : 'bg-gray-700'}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${settings[opt.key as keyof typeof settings] ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
          </label>
        ))}
      </section>

      {/* Editor */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">Editor</h2>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Font Size: {settings.fontSize}px</label>
          <input type="range" min="11" max="20" value={settings.fontSize}
            onChange={e => updateSettings({ fontSize: parseInt(e.target.value) })}
            className="w-full" />
        </div>
        <label className="flex items-center justify-between cursor-pointer">
          <p className="text-sm text-gray-200">Show Line Numbers</p>
          <div
            onClick={() => updateSettings({ showLineNumbers: !settings.showLineNumbers })}
            className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${settings.showLineNumbers ? 'bg-aether-600' : 'bg-gray-700'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${settings.showLineNumbers ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </div>
        </label>
      </section>

      <button onClick={handleSave} className="btn-primary">
        <Save className="w-4 h-4" /> Save Settings
      </button>
    </div>
  );
}
