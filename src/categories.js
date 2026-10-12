// The 10 story categories shown in the post form and on pins.
export const CATEGORIES = [
  { id: "Accident", icon: "💥" },
  { id: "Natural Disaster", icon: "🌊" },
  { id: "Crime", icon: "🚨" },
  { id: "Medical emergency", icon: "🏥" },
  { id: "Road closure", icon: "🚧" },
  { id: "Blocked lane", icon: "⛔" },
  { id: "Bad weather", icon: "🌧️" },
  { id: "Events", icon: "🎪" },
  { id: "Environmental Pollution", icon: "🏭" },
  { id: "Vehicle Breakdowns", icon: "🔧" },
];
export const iconFor = (id) => CATEGORIES.find((c) => c.id === id)?.icon || "📍";
