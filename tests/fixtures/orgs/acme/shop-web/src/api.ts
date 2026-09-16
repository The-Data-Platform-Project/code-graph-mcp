const BASE = import.meta.env.VITE_API_URL ?? 'https://api.acme.example';

export interface Order {
  id: string;
  total: number;
}

export async function fetchOrders(customerId: string): Promise<Order[]> {
  const res = await fetch(`${BASE}/api/orders?customer=${customerId}`);
  return res.json();
}

export async function createOrder(payload: Order): Promise<Order> {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.json();
}
