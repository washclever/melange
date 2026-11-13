.subckt c1_005_casmirror vss id out
M1 n1 n1 vss vss nmos_rvt w=1260e-9 l=150e-9 nf=6 stack=2
M2 n2 n1 vss vss nmos_rvt w=1260e-9 l=150e-9 nf=6 stack=2
M3 id id n1 vss nmos_rvt w=1.26e-6 l=150e-9 nf=6
M4 out id n2 vss nmos_rvt w=1.26e-6 l=150e-9 nf=6
.ends c1_005_casmirror
