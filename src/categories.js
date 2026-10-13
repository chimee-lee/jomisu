// The 10 story categories shown in the post form and on pins.
export const CATEGORIES = [
  { id: "Accident", icon: "💥" },
  { id: "Natural Disaster", icon: "🌊" },
  { id: "Crime", icon: "🚨" },
  { id: "Medical Emergency", icon: "🏥" },
  { id: "Road Closure", icon: "🚧" },
  { id: "Blocked Lane", icon: "⛔" },
  { id: "Bad Weather", icon: "🌧️" },
  { id: "Events", icon: "🎪" },
  { id: "Environmental Pollution", icon: "🏭" },
  { id: "Vehicle Breakdowns", icon: "🔧" },
  { id: "Others", icon: "➕" },
];
export const iconFor = (id) => CATEGORIES.find((c) => c.id.toLowerCase() === String(id).toLowerCase())?.icon || "📍";
