.subckt d2_002_series vdd vss in vb out
M1 out in x0 vss nmos_rvt w=840e-9 l=150e-9 nf=10 m=1
M2 x0 in vss vss nmos_rvt w=840e-9 l=150e-9 nf=10 m=1
M3 out vb vdd vdd pmos_lvt w=840e-9 l=150e-9 nf=6 m=2
.ends d2_002_series
