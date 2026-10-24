from dataclasses import dataclass, field

from .pricing import TAX_RATE


@dataclass
class Order:
    lines: list = field(default_factory=list)

    def add(self, sku: str, quantity: int, unit_price: float) -> None:
        self.lines.append((sku, quantity, unit_price))

    def tax_rate(self) -> float:
        return TAX_RATE
