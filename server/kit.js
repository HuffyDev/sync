// Survival gear checklist: what to own before an outage, what to look for
// when buying it, and roughly what it costs (US dollars, typical range).
export const KIT_CATEGORIES = [
  ['power', 'Power'], ['water', 'Water'], ['medical', 'Medical'], ['comms', 'Comms'], ['light', 'Light & fire'],
  ['shelter', 'Shelter & warmth'], ['food', 'Food'], ['tools', 'Tools'], ['data', 'Documents & data'],
];

export const KIT = [
  { id: 'power-bank', cat: 'power', level: 'essential', name: 'Power bank', price: '$25–60',
    why: 'Keeps phones, a radio or a GPS running for days with no grid power.',
    look: ['20,000 mAh or more', 'USB-C Power Delivery (charges laptops and phones fast)', 'A battery level display', 'Store at about half charge and top up every few months'] },
  { id: 'solar-panel', cat: 'power', level: 'recommended', name: 'Folding solar panel', price: '$50–120',
    why: 'Refills power banks for as long as the outage lasts.',
    look: ['20–30 W or more for real charging speed', 'USB-A and USB-C outputs', 'Auto-restart after a cloud passes', 'Loops or grommets to hang it toward the sun'] },
  { id: 'power-station', cat: 'power', level: 'recommended', name: 'Portable power station', price: '$250–900',
    why: 'Runs lights, a laptop, a router or a small fridge silently — and, unlike a generator, it is safe to use indoors.',
    look: ['LiFePO4 battery chemistry (long life, safer)', '300–1,000 Wh capacity', 'Pure sine wave AC outlets', 'Solar input so panels can recharge it'] },
  { id: 'batteries', cat: 'power', level: 'essential', name: 'Spare batteries', price: '$10–25',
    why: 'Flashlights and radios die first in a long outage.',
    look: ['Sizes that match your devices (usually AA/AAA)', 'Lithium AA for cold weather and long storage', 'Check dates once a year'] },

  { id: 'water-store', cat: 'water', level: 'essential', name: 'Stored drinking water', price: '$0–40',
    why: 'Taps can stop or become unsafe. You need about 1 gallon (4 L) per person per day.',
    look: ['At least 3 days per person and pet; 2 weeks if you can', 'Food-grade containers with tight lids', 'Replace self-filled water every 6 months'] },
  { id: 'water-filter', cat: 'water', level: 'essential', name: 'Portable water filter', price: '$20–60',
    why: 'Makes stream, rain or tap water drinkable when boiling isn\'t possible.',
    look: ['Removes bacteria and protozoa (pore size about 0.1–0.2 micron)', 'Independently tested to a recognised standard', 'Most filters do NOT remove viruses — also disinfect with tablets or bleach'] },
  { id: 'water-tabs', cat: 'water', level: 'recommended', name: 'Water purification tablets', price: '$10–20',
    why: 'Light, cheap disinfection that also handles viruses.',
    look: ['Chlorine dioxide tablets', 'Check the expiry date', 'Follow the wait time on the pack (often 30 minutes to 4 hours)'] },
  { id: 'bleach', cat: 'water', level: 'recommended', name: 'Unscented bleach + dropper', price: '$3–8',
    why: 'Disinfects water and surfaces (see the Water guide for doses).',
    look: ['Plain, unscented 6% or 8.25% sodium hypochlorite', 'A clean medicine dropper', 'Replace about once a year — bleach weakens over time'] },

  { id: 'first-aid-kit', cat: 'medical', level: 'essential', name: 'First aid kit', price: '$25–60',
    why: 'Treat cuts, burns and sprains when help is far away.',
    look: ['Gauze pads and rolls, bandages, medical tape', 'Gloves, antiseptic wipes, tweezers, scissors', 'Add your own medicines and a printed first aid guide'] },
  { id: 'tourniquet', cat: 'medical', level: 'recommended', name: 'Tourniquet', price: '$30–40',
    why: 'Stops life-threatening limb bleeding when pressure isn\'t enough.',
    look: ['A windlass-style tourniquet from a reputable maker — avoid cheap copies', 'Take a short bleeding-control course (e.g. Stop the Bleed)', 'Keep it where you can reach it fast'] },
  { id: 'meds', cat: 'medical', level: 'essential', name: '7-day medicine supply', price: 'varies',
    why: 'Pharmacies may be closed or unreachable.',
    look: ['At least a week of prescription medicines', 'Pain and fever reducer, oral rehydration salts', 'A written list of medicines and doses'] },

  { id: 'radio', cat: 'comms', level: 'essential', name: 'Battery or hand-crank radio', price: '$25–60',
    why: 'Emergency broadcasts keep working when phones and internet don\'t.',
    look: ['AM/FM, plus NOAA Weather Radio bands in the US', 'Hand crank or solar, and AA backup', 'Built-in light and USB output are a bonus'] },
  { id: 'whistle', cat: 'comms', level: 'essential', name: 'Whistle', price: '$3–10',
    why: 'Three blasts means "help" and carries much farther than a voice.',
    look: ['Loud, pea-less design that works when wet', 'One per person, on a lanyard or keychain'] },
  { id: 'walkie', cat: 'comms', level: 'recommended', name: 'Two-way radios', price: '$30–70',
    why: 'Talk to your household across the neighborhood with no network.',
    look: ['FRS radios need no license in the US', 'Expect realistic range of about 0.5–2 miles in town', 'Rechargeable plus AA battery option'] },

  { id: 'flashlight', cat: 'light', level: 'essential', name: 'Flashlight or headlamp per person', price: '$15–40',
    why: 'Safe light without fire. Headlamps keep your hands free.',
    look: ['LED, with a low mode for long runtime', 'Uses the same batteries as your other gear', 'A red-light mode protects night vision'] },
  { id: 'lantern', cat: 'light', level: 'recommended', name: 'LED lantern', price: '$15–35',
    why: 'Lights a whole room without the fire risk of candles.',
    look: ['200 lumens or more', 'Rechargeable or AA', 'Hanging hook'] },
  { id: 'co-alarm', cat: 'light', level: 'essential', name: 'Battery carbon monoxide alarm', price: '$20–40',
    why: 'Generators, heaters and stoves cause deadly CO poisoning during outages.',
    look: ['Battery-powered or battery backup', 'Certified to a recognised CO alarm standard (UL 2034 in the US)', 'One near sleeping areas'] },
  { id: 'extinguisher', cat: 'light', level: 'essential', name: 'Fire extinguisher', price: '$25–60',
    why: 'Fires are more likely when people use candles and fuel for light and heat.',
    look: ['Multipurpose "ABC" rating', 'Check the pressure gauge is in the green', 'Learn PASS: Pull, Aim, Squeeze, Sweep'] },
  { id: 'fire-start', cat: 'light', level: 'recommended', name: 'Lighter and waterproof matches', price: '$5–15',
    why: 'For outdoor cooking and lighting a fireplace or stove safely.',
    look: ['Two ways to make fire', 'Keep in a sealed bag'] },

  { id: 'warmth', cat: 'shelter', level: 'essential', name: 'Sleeping bags or warm blankets', price: '$10–80',
    why: 'Homes get dangerously cold within a day or two without heat.',
    look: ['One per person, rated for your coldest nights', 'Wool blankets stay warm when damp', 'Emergency space blankets for the go-bag'] },
  { id: 'tarp', cat: 'shelter', level: 'recommended', name: 'Tarp, duct tape and cord', price: '$15–40',
    why: 'Covers broken windows or a damaged roof and makes a quick shelter.',
    look: ['Heavy-duty tarp with grommets', 'A full roll of duct tape', '50 ft (15 m) of strong cord'] },

  { id: 'food', cat: 'food', level: 'essential', name: '2-week food supply', price: '$40–150',
    why: 'Stores may be closed or empty for days.',
    look: ['Food you already eat that needs no cooking or fridge', 'A manual can opener', 'Rotate it into your normal meals so nothing expires'] },
  { id: 'stove', cat: 'food', level: 'recommended', name: 'Camp stove and fuel (outdoor use)', price: '$30–80',
    why: 'Cook and boil water when the power is out.',
    look: ['Use only outdoors — never inside, in a garage or a tent', 'Enough fuel for boiling water daily', 'Store fuel away from living areas'] },

  { id: 'multitool', cat: 'tools', level: 'recommended', name: 'Multitool and wrench', price: '$25–60',
    why: 'Small repairs, opening packaging, turning off utilities if told to.',
    look: ['Pliers, knife, screwdrivers', 'An adjustable wrench for utility shut-offs', 'Work gloves'] },
  { id: 'masks', cat: 'tools', level: 'recommended', name: 'N95 masks', price: '$15–30',
    why: 'Protect against wildfire smoke and dust after storms or earthquakes.',
    look: ['NIOSH-approved N95 (cloth masks do not filter smoke)', 'Several per person', 'Sizes that fit children if you have them'] },

  { id: 'documents', cat: 'data', level: 'essential', name: 'Copies of important documents', price: '$5–15',
    why: 'You may need ID, insurance and medical details to get help or rebuild.',
    look: ['Copies of IDs, insurance, deeds and medical info', 'A waterproof bag', 'A USB drive with LASTSYNC and your plan on it'] },
  { id: 'cash', cat: 'data', level: 'essential', name: 'Cash in small bills', price: 'your choice',
    why: 'Card readers and ATMs need power and network.',
    look: ['Small bills and some coins', 'Enough for a few days of essentials and fuel'] },
];

export function kitSummary(have) {
  const essentials = KIT.filter((k) => k.level === 'essential');
  const covered = essentials.filter((k) => have[k.id]).length;
  return { essentials: essentials.length, covered, pct: Math.round((100 * covered) / essentials.length), owned: KIT.filter((k) => have[k.id]).length, total: KIT.length };
}
