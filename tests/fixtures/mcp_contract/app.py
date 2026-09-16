from pkg.core import Widget, build


def main():
    return build(5)


def make():
    return Widget(1)


def orphan():
    return does_not_exist(1)
