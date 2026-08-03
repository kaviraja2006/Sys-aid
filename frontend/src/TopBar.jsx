export default function TopBar({ user, onLogout }) {
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-2 border-b border-[#232427] bg-[#151618]">
      {user.picture && <img src={user.picture} alt="" className="w-6 h-6 rounded-full" />}
      <span className="text-xs text-gray-300">{user.name || user.email}</span>
      <button onClick={onLogout} className="text-xs text-gray-400 hover:text-gray-200 underline">
        Sign out
      </button>
    </div>
  );
}
