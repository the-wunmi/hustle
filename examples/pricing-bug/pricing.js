// Order total: 10% off from 20 units.
export function total(units, price) {
  const gross = units * price;
  return units > 20 ? gross * 0.9 : gross;
}
