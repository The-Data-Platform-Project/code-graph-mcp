import { fetchOrders, Order } from './api';

export function OrderList({ customerId }: { customerId: string }) {
  const orders: Order[] = [];
  fetchOrders(customerId).then((loaded) => orders.push(...loaded));
  return orders;
}

export function App() {
  return OrderList({ customerId: 'demo' });
}
