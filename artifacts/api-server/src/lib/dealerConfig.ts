/**
 * Dealership identity — greetings, hours, and address read this instead of
 * hard-coded Shubham/Jaipur strings so a second outlet can be configured.
 */
export type DealerConfig = {
  name: string;
  city: string;
  brand: string;
  address: string;
  hours: string;
  phone: string;
  agentName: string;
};

export function dealerConfig(env: NodeJS.ProcessEnv = process.env): DealerConfig {
  return {
    name: env.DEALER_NAME ?? "Shubham Motors",
    city: env.DEALER_CITY ?? "Jaipur",
    brand: env.DEALER_BRAND ?? "Hero MotoCorp",
    address: env.DEALER_ADDRESS ?? "Lal Kothi, Tonk Road, Jaipur",
    hours: env.DEALER_HOURS ?? "सोमवार से शनिवार सुबह 9 से शाम 7, रविवार सुबह 10 से शाम 5",
    phone: env.DEALER_PHONE ?? "0141-4937655",
    agentName: env.AGENT_NAME ?? "साक्षी",
  };
}
