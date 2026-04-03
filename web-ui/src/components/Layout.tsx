import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, GitBranch, Shield, Puzzle, Settings,
  LayoutDashboard, ChevronLeft, ChevronRight, Zap,
  Circle, Wifi, WifiOff
} from 'lucide-react';
import { useStore } from '../store/index.ts';
import { clsx } from 'clsx';

const NAV_ITEMS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat', icon: MessageSquare, label: 'Chat' },
  { to: '/pipeline', icon: Zap, label: 'Pipeline' },
  { to: '/review', icon: Shield, label: 'Review' },
  { to: '/plugins', icon: Puzzle, label: 'Plugins' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout() {
  const { sidebarOpen, setSidebarOpen, engineStatus } = useStore();

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* Sidebar */}
      <motion.aside
        animate={{ width: sidebarOpen ? 220 : 64 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className="flex-shrink-0 flex flex-col bg-gray-900 border-r border-gray-800"
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-800 overflow-hidden">
          <div className="flex-shrink-0 w-8 h-8 bg-aether-600 rounded-lg flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          {sidebarOpen && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="overflow-hidden">
              <div className="text-sm font-bold text-white truncate">AetherDev</div>
              <div className="text-xs text-gray-500 truncate">AI Agent</div>
            </motion.div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto overflow-x-hidden">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-2 py-2.5 rounded-lg transition-colors',
                  isActive
                    ? 'bg-aether-900/50 text-aether-400'
                    : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
                )
              }
              title={!sidebarOpen ? item.label : undefined}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              {sidebarOpen && (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm font-medium truncate">
                  {item.label}
                </motion.span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Engine Status */}
        <div className="px-2 py-3 border-t border-gray-800">
          <div className={clsx(
            'flex items-center gap-2 px-2 py-2 rounded-lg',
            sidebarOpen ? '' : 'justify-center'
          )}>
            {engineStatus.ollamaOnline
              ? <Wifi className="w-4 h-4 text-green-400 flex-shrink-0" />
              : <WifiOff className="w-4 h-4 text-red-400 flex-shrink-0" />
            }
            {sidebarOpen && (
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-300 truncate">{engineStatus.model}</div>
                <div className={clsx('text-xs', engineStatus.ollamaOnline ? 'text-green-400' : 'text-red-400')}>
                  {engineStatus.ollamaOnline ? 'Online' : 'Offline'}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center py-3 border-t border-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
        >
          {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={useLocation().pathname}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="h-full overflow-auto"
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
