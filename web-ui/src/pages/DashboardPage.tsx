import React from 'react';
import { Activity, Zap, Shield, GitBranch, Code2, TrendingUp, Clock, CheckCircle } from 'lucide-react';
import { useStore } from '../store/index.ts';
import { useEngineStatus } from '../hooks/useApi.ts';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

const mockTokenData = Array.from({ length: 12 }, (_, i) => ({
  time: `${i + 1}h`,
  tokens: Math.floor(Math.random() * 5000 + 500),
  requests: Math.floor(Math.random() * 20 + 2),
}));

const mockQualityData = [
  { name: 'Security', score: 85 },
  { name: 'Performance', score: 72 },
  { name: 'Maintain.', score: 78 },
  { name: 'Testing', score: 65 },
];

export default function DashboardPage() {
  const { engineStatus, pipelineRuns, sessions } = useStore();
  const { data: status } = useEngineStatus();

  const completedRuns = pipelineRuns.filter(r => r.status === 'done');
  const avgQuality = completedRuns
    .filter(r => r.qualityScore)
    .reduce((s, r) => s + (r.qualityScore ?? 0), 0) / (completedRuns.filter(r => r.qualityScore).length || 1);

  const stats = [
    { label: 'Pipeline Runs', value: pipelineRuns.length, icon: Zap, color: 'text-aether-400', bg: 'bg-aether-900/30' },
    { label: 'Total Tokens', value: (engineStatus.totalTokens / 1000).toFixed(1) + 'K', icon: Activity, color: 'text-purple-400', bg: 'bg-purple-900/30' },
    { label: 'Sessions', value: sessions.length, icon: Code2, color: 'text-green-400', bg: 'bg-green-900/30' },
    { label: 'Avg Quality', value: `${Math.round(avgQuality || 0)}/100`, icon: Shield, color: 'text-yellow-400', bg: 'bg-yellow-900/30' },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-500 mt-1">AetherDev system overview</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded-lg">
          <div className={`w-2 h-2 rounded-full ${engineStatus.ollamaOnline ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
          <span className="text-sm text-gray-300">{engineStatus.model}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {stats.map(stat => (
          <div key={stat.label} className="card">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-400">{stat.label}</span>
              <div className={`w-8 h-8 rounded-lg ${stat.bg} flex items-center justify-center`}>
                <stat.icon className={`w-4 h-4 ${stat.color}`} />
              </div>
            </div>
            <div className="text-2xl font-bold text-white">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">Token Usage (24h)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={mockTokenData}>
              <defs>
                <linearGradient id="tokenGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="time" stroke="#6b7280" tick={{ fontSize: 11 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
              <Area type="monotone" dataKey="tokens" stroke="#0ea5e9" fill="url(#tokenGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">Code Quality Scores</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={mockQualityData} barSize={32}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis dataKey="name" stroke="#6b7280" tick={{ fontSize: 11 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} domain={[0, 100]} />
              <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
              <Bar dataKey="score" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent Runs */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-300 mb-4">Recent Pipeline Runs</h3>
        {pipelineRuns.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-8">No pipeline runs yet. Start generating code!</p>
        ) : (
          <div className="space-y-2">
            {pipelineRuns.slice(0, 8).map(run => (
              <div key={run.id} className="flex items-center gap-4 p-3 bg-gray-800 rounded-lg">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  run.status === 'done' ? 'bg-green-400' :
                  run.status === 'error' ? 'bg-red-400' : 'bg-yellow-400 animate-pulse'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 truncate">{run.prompt}</p>
                  <p className="text-xs text-gray-500">{run.taskType} · {new Date(run.startedAt).toLocaleTimeString()}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {run.qualityScore && (
                    <span className={`text-xs font-medium ${run.qualityScore >= 80 ? 'text-green-400' : run.qualityScore >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {run.qualityScore}/100
                    </span>
                  )}
                  <span className="text-xs text-gray-500">{(run.totalTokens / 1000).toFixed(1)}K tokens</span>
                  {run.status === 'done' && <CheckCircle className="w-4 h-4 text-green-400" />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
