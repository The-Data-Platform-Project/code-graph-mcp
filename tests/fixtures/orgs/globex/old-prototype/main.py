import urllib.request


def fetch(url):
    return urllib.request.urlopen(url).read()


def main():
    return fetch("http://example.invalid/data")
