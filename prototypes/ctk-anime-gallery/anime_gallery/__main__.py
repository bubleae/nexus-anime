import logging

from anime_gallery.ui.app import AnimeGalleryApp


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    app = AnimeGalleryApp()
    app.mainloop()


if __name__ == "__main__":
    main()
