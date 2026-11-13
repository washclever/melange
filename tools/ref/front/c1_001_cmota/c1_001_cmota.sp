.subckt c1_001_cmota vss vdd vout vinn vinp id
M5 id id vss vss nmos_lvt w=0.42e-6 l=150e-9 nf=8
M4 source id vss vss nmos_rvt w=0.42e-6 l=150e-9 nf=8
M3 net7 vinn source vss sky130_fd_pr__nfet_01v8 w=10.5e-7 l=150e-9 nf=8
M0 net8 vinp source vss sky130_fd_pr__nfet_01v8 w=10.5e-7 l=150e-9 nf=8
M2 net7 net7 vdd vdd pmos_rvt w=1260e-9 l=150e-9 nf=16
M6 vout net7 vdd vdd pmos_rvt w=1260e-9 l=150e-9 nf=12
M1 net8 net8 vdd vdd pmos_rvt w=1260e-9 l=150e-9 nf=16
M7 net9 net8 vdd vdd pmos_rvt w=1260e-9 l=150e-9 nf=12
M8 net9 net9 vss vss sky130_fd_pr__nfet_01v8 w=630e-9 l=150e-9 nf=10 m=2
M9 vout net9 vss vss sky130_fd_pr__nfet_01v8 w=630e-9 l=150e-9 nf=10 m=2
.ends c1_001_cmota
