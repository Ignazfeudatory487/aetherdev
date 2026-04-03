import React from 'react';
import { Puzzle, RefreshCw, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { usePlugins, useReloadPlugin } from '../hooks/useApi.ts';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';

export default function PluginsPage() {
  const { data: plugins, isLoading } = usePlugins();
  const reloadPlugin = useReloadPlugin();

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Plugins</h1>
        <p className="text-gray-500 mt-1">Extend AetherDev with custom plugins. Place plugin directories in <code className="text-aether-400 text-sm">./plugins/</code></p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-aether-400" />
        </div>
      ) : !plugins?.length ? (
        <div className="card text-center py-16">
          <Puzzle className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-gray-400 font-medium">No plugins installed</h3>
          <p className="text-gray-600 text-sm mt-2 max-w-sm mx-auto">
            Create a directory in <code className="text-aether-400">./plugins/my-plugin/</code> with a <code className="text-aether-400">plugin.json</code> manifest and main entry file.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {plugins.map(plugin => (
            <div key={plugin.name} className="card flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center">
                  <Puzzle className="w-5 h-5 text-aether-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-200">{plugin.name}</span>
                    <span className="text-xs text-gray-500">v{plugin.version}</span>
                    {plugin.status === 'active'
                      ? <CheckCircle className="w-4 h-4 text-green-400" />
                      : <XCircle className="w-4 h-4 text-red-400" />
                    }
                  </div>
                  <p className="text-sm text-gray-500">{plugin.description}</p>
                </div>
              </div>
              <button
                onClick={() => reloadPlugin.mutateAsync(plugin.name).then(() => toast.success(`Reloaded: ${plugin.name}`)).catch(() => toast.error('Reload failed'))}
                disabled={reloadPlugin.isPending}
                className="btn-secondary text-sm"
              >
                <RefreshCw className={clsx('w-4 h-4', reloadPlugin.isPending && 'animate-spin')} />
                Reload
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Plugin Dev Guide */}
      <div className="card border-dashed border-gray-700">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Create a Plugin</h3>
        <pre className="code-block text-xs">
{`// plugins/my-plugin/plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "main": "index.js",
  "hooks": ["after:generate", "on:startup"]
}

// plugins/my-plugin/index.js
module.exports = {
  hooks: {
    "after:generate": async (ctx) => {
      console.log("Code generated!", ctx.data);
    }
  },
  onLoad: async () => { console.log("Plugin loaded!"); }
};`}
        </pre>
      </div>
    </div>
  );
}
