from .utils import Base, helper


class Widget(Base):
    def __init__(self, n: int):
        self.n = n

    def run(self):
        return helper(self.n)

    def greet_twice(self):
        return self.greet() + self.greet()


def build(n):
    w = Widget(n)
    return w.run()
