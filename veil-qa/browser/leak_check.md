# Leak check procedure (Gate 2)

Goal: prove that no traffic leaves the machine except Tor traffic to the
guard relay, in both workspaces, during a scripted session.

1. Fresh VM with no other network services; record the default interface.
2. Start a capture on that interface: `tcpdump -i <iface> -w session.pcap`.
3. Launch VEIL, let Tor bootstrap, and note the guard IP from `about:tor` or the control port.
4. Run the scripted session: load 20 test sites over HTTPS and onion services, trigger WebRTC
   (a page calling `RTCPeerConnection` with a STUN server), DNS-heavy pages, a download, a PDF,
   New Identity, New Circuit, switch workspaces, and an update check.
5. Stop the capture and filter: `tshark -r session.pcap -Y "not ip.addr == <guard_ip>"`.
6. Pass: the filter shows nothing except local DHCP/ARP. Any DNS query, STUN packet or
   direct TCP/UDP connection is a failure.

For the authenticated workspace, repeat with one site switched to a direct
connection: traffic to that site's IP is expected and must be the only extra
traffic. Automating this procedure is part of stage 2.
