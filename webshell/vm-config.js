// VM settings shared by the page (app.js) and image/build-state.mjs.
// A saved boot snapshot only restores into a VM with identical settings.
// cache=mmap: the guest doesn't cache file data or directory entries, so changes made
// outside the VM (host files under /host) show up immediately.
(function (root) {
  const config = {
    memory_size: 512 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    cmdline:
      "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=mmap modules=virtio_pci " +
      "tsc=reliable init_on_free=on console=ttyS0 quiet loglevel=3",
  };
  if (typeof module === "object" && module.exports) module.exports = config;
  else root.WEBSHELL_VM = config;
})(this);
