.subckt d2_000_ota vdd vss inp inn o2 id
M1 id id vss vss sky130_fd_pr__nfet_01v8 w=630e-9 l=150e-9 nf=6
M2 tail id vss vss sky130_fd_pr__nfet_01v8 w=630e-9 l=150e-9 nf=6
M3 o1 inp tail vss sky130_fd_pr__nfet_01v8 w=1260e-9 l=150e-9 nf=6
M4 o2 inn tail vss sky130_fd_pr__nfet_01v8 w=1260e-9 l=150e-9 nf=6
M5 o1 o1 vdd vdd sky130_fd_pr__pfet_01v8 w=420e-9 l=150e-9 nf=10
M6 o2 o1 vdd vdd sky130_fd_pr__pfet_01v8 w=420e-9 l=150e-9 nf=10
.ends d2_000_ota
